/**
 * Indexing and retrieval over published versions.
 *
 * Two halves, deliberately kept in one file because they are the two ends of one
 * invariant: what gets indexed here is exactly what `ai_search_chunks` can
 * return, and both sides are written so that neither can widen access.
 *
 * The SQL function does the authorization (it takes the actor and calls
 * `can_access_document` in its own WHERE clause — PLAN §3.2, "filter in the
 * query"). Nothing in this file filters rows in TypeScript, which means there is
 * no place here where a forbidden chunk arrives and has to be noticed. The test
 * suite asserts the exclusion through the function itself for that reason.
 */

import { Inject, Injectable } from '@nestjs/common';
import { query, withTransaction } from '../db';
import { chunkVersion } from './chunk';
import { vectorToSqlLiteral, type EmbeddingProvider, EMBEDDING_PROVIDER } from './embedding.provider';

/** A retrieved chunk, already ACL-filtered and score-converted. */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  versionNumber: number;
  anchor: string | null;
  heading: string;
  text: string;
  /** Cosine distance from the index; `score` is the caller-facing form. */
  distance: number;
  /** 1 − distance, so "higher is more relevant" and a threshold reads naturally. */
  score: number;
}

const HALFVEC = 'halfvec(1024)';

/**
 * Replace one document's indexed chunks with the ones from its newest version.
 *
 * A module function rather than a service method, because two callers need it and
 * only one of them is a Nest request: publish reindexes through the service, and
 * `seed.ts` — which inserts version rows with raw SQL and never boots an
 * application — calls it directly. A seed that published without indexing would
 * hand every AI test an empty corpus and let it pass by answering "not covered",
 * which is this phase's most dangerous shape of green: the bot's *refusal* is a
 * valid answer, so a broken corpus looks like a working refusal.
 *
 * Delete-then-insert in one transaction, which the DEFERRED constraint trigger on
 * `document_chunks` is what makes legal: an immediate trigger would fire on the
 * INSERT and see both versions. Commit-time enforcement means the table can never
 * end a transaction holding one document's chunks from two versions, whichever
 * code path did the writing — including a future reindex that forgets the delete.
 *
 * The version is read from `document_versions` rather than passed in, so
 * "indexed" cannot drift from "published" by a row: whatever the database says is
 * newest is what becomes retrievable.
 *
 * Embedding happens *outside* the transaction. The hashing provider is synchronous
 * and fast, but the shape is the honest one — a real provider is a network call,
 * and a network call inside a transaction holding row locks on a document is how a
 * publish starts deadlocking.
 */
export async function reindexDocument(embeddings: EmbeddingProvider, documentId: string): Promise<number> {
  const versions = await query<{ id: string; number: number; title: string; body: unknown }>(
    `SELECT v.id, v.number, v.title, v.body
       FROM document_versions v
      WHERE v.document_id = $1
      ORDER BY v.number DESC
      LIMIT 1`,
    [documentId],
  );
  const version = versions[0];
  if (!version) {
    // Never published: nothing may be retrievable from a draft. Clear any chunks
    // anyway, because a document whose versions are gone entirely (deleted history
    // cascades) must not keep answerable text from a version that no longer exists.
    await query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
    return 0;
  }

  const chunks = chunkVersion(version.body, version.title);
  const vectors = embeddings.embed(chunks.map((chunk) => chunk.text));

  await withTransaction(async (client) => {
    await client.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
    for (const [index, chunk] of chunks.entries()) {
      await client.query(
        `INSERT INTO document_chunks
           (document_id, version_id, version_number, ord, anchor, heading, text, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::halfvec(1024))`,
        [
          documentId,
          version.id,
          version.number,
          chunk.ord,
          chunk.anchor,
          chunk.heading,
          chunk.text,
          vectorToSqlLiteral(vectors[index] ?? []),
        ],
      );
    }
  });
  return chunks.length;
}

@Injectable()
export class RetrievalService {
  constructor(@Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider) {}

  /** Publish's hook. See `reindexDocument` for what it does and why it is shaped so. */
  reindexDocument(documentId: string): Promise<number> {
    return reindexDocument(this.embeddings, documentId);
  }

  /**
   * The retrieval call. Note the actor is passed *into* the SQL function rather
   * than used to pre-filter an id list: a `WHERE document_id = ANY(permitted)`
   * assembled in TypeScript would be a second, rival implementation of the ACL,
   * and PLAN §3.1 allows exactly one thing to decide access.
   */
  async search(actorId: string, question: string, limit = 5): Promise<RetrievedChunk[]> {
    const [vector] = this.embeddings.embed([question]);
    if (!vector) throw new Error('embedding provider returned no vector for a single input');
    return this.searchByVector(actorId, vector, limit);
  }

  /**
   * Same query, for a caller that already has a vector.
   *
   * Kept public because the ACL test needs it: proving that a forbidden
   * document's chunk is excluded requires handing the search an embedding that is
   * *maximally similar* to that chunk, which is only constructible from the
   * chunk's own text. Asking the real embedder politely with a chosen question
   * would leave the test unable to tell "the ACL excluded it" apart from "the
   * embedder just did not find it interesting".
   */
  async searchByVector(actorId: string, vector: readonly number[], limit = 5): Promise<RetrievedChunk[]> {
    const rows = await query<{
      chunk_id: string;
      document_id: string;
      document_title: string;
      version_number: number;
      anchor: string | null;
      heading: string;
      chunk_text: string;
      distance: number;
    }>(`SELECT * FROM ai_search_chunks($1, $2::${HALFVEC}, $3)`, [
      actorId,
      vectorToSqlLiteral(vector),
      limit,
    ]);
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      versionNumber: row.version_number,
      anchor: row.anchor,
      heading: row.heading,
      text: row.chunk_text,
      distance: row.distance,
      score: 1 - row.distance,
    }));
  }
}
