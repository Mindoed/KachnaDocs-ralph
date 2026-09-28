/* eslint-disable camelcase */

/**
 * Phase 5: retrieval storage and the ACL-filtered similarity search.
 *
 * PLAN §2.1 says the pgvector half is *real*: real embeddings column, real HNSW
 * index, real similarity search, real ACL filtering — only the LLM is stubbed.
 * Everything below is therefore load-bearing rather than decorative, and four
 * of its decisions are consequences of things that are easy to get wrong.
 *
 * ## halfvec(1024), not vector(1024)
 *
 * pgvector's HNSW index refuses `vector` above 2000 dimensions but allows
 * `halfvec` to 4000. Two-byte components halve the index and the table, and
 * cosine over `halfvec` needs the matching `_cosine_ops` operator class — a
 * `vector_cosine_ops` index cannot serve an ORDER BY on a halfvec column, so
 * the column type, the operator class and every query's casts have to agree.
 * Half precision is irrelevant to a hashing embedder's ranking and it keeps the
 * door open to a real 1024-dimension model without a migration.
 *
 * ## hnsw.iterative_scan is not optional
 *
 * HNSW returns the approximate top-k *first*, and Postgres applies the WHERE
 * clause afterwards. With an ACL predicate that is not a detail but a failure:
 * the k nearest chunks can all belong to documents the actor cannot READ, the
 * post-filter empties the batch, and the scan stops having produced its limit —
 * answering "the documentation does not cover that" about content that is in
 * the database and readable. Verified against this database before writing it:
 * 500 forbidden chunks nearer than the single permitted chunk, `limit 3` =>
 * **0 rows** with a plain index scan, **1 row** with
 * `hnsw.iterative_scan = 'relaxed_order'` (pgvector 0.8.x keeps draining the
 * index until the limit is satisfied). The retrieval function therefore carries
 * it in a function-scoped `SET` clause, which was also verified to reach the
 * planner while the calling session still reported the GUC as `off`.
 *
 * `relaxed_order` rather than `strict_order` because the caller applies a score
 * threshold rather than trusting an exact ranking: relaxed can return the rows
 * slightly out of distance order, which cannot change a threshold decision
 * because a threshold is per-row and order-independent.
 *
 * ## exactly one version per document, enforced in the schema
 *
 * Retrieval must read a document's *newest published* version. Doing it with a
 * `number = (select max(number) …)` predicate works but leaves stale chunks
 * sitting in the table, silently invisible to retrieval and impossible to tell
 * apart from missing ones. Instead: an ordinary delete-then-insert reindex, and
 * a DEFERRED constraint trigger asserting at commit that a document never ends
 * a transaction with chunks from two versions. Deferred is what makes the
 * reindex possible at all — an immediate trigger fires on the INSERT, before
 * the same transaction's DELETE has been seen. Unique `(document_id, ord)`
 * doubles as the lookup path the trigger needs and as the reindex's idempotency.
 *
 * ## ACL inside the function
 *
 * `ai_search_chunks` takes the actor and calls `can_access_document` in its own
 * WHERE clause, so the filter cannot be dropped by a caller assembling its own
 * SQL — PLAN §3.2's "filter in the query" for the AI path specifically. The
 * function is also the only retrieval query in the phase, which is what makes
 * "assert it via the query" in the prompt a checkable instruction.
 */

const VECTOR_DIMENSIONS = 1024;

exports.up = (pgm) => {
  pgm.createTable(
    'document_chunks',
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      document_id: {
        type: 'uuid',
        notNull: true,
        references: 'documents(id)',
        onDelete: 'CASCADE',
      },
      // Denormalised for the same reason the version snapshot denormalises its
      // title: a chunk must be explainable from its own row, and a citation
      // needs the version it was cut from without re-deriving "newest".
      version_id: {
        type: 'uuid',
        notNull: true,
        references: 'document_versions(id)',
        onDelete: 'CASCADE',
      },
      version_number: { type: 'integer', notNull: true },
      ord: { type: 'integer', notNull: true },
      // The heading the chunk sits under, and that heading's anchor: SPEC §5
      // requires a citation to link to "dokument nebo konkrétní nadpis", so the
      // anchor has to travel with the chunk rather than be looked up afterwards.
      // Nullable because a chunk before the first heading of a heading-less
      // document is under no heading at all; SPEC §5 accepts a document-level
      // citation, and inventing an anchor with no `headings` row behind it would
      // be a citation that resolves nowhere.
      anchor: { type: 'text' },
      heading: { type: 'text', notNull: true },
      text: { type: 'text', notNull: true },
      embedding: { type: `halfvec(${VECTOR_DIMENSIONS})`, notNull: true },
      embedded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {},
  );

  pgm.createIndex('document_chunks', ['document_id', 'ord'], { unique: true });
  pgm.createIndex('document_chunks', 'version_id');
  pgm.createIndex('document_chunks', 'version_number');
  // The ORDER BY the whole feature exists to serve. Raw SQL rather than
  // createIndex: node-pg-migrate drops the `ops` option when the column is not
  // an expression, and `halfvec` has no *default* operator class for hnsw — the
  // first attempt failed with `data type halfvec has no default operator class
  // for access method "hnsw"`, which is the operator class saying that the
  // column type and the opclass have to be named together.
  pgm.sql(`
    CREATE INDEX document_chunks_embedding_hnsw
      ON document_chunks USING hnsw (embedding halfvec_cosine_ops);
  `);

  pgm.sql(`
    CREATE FUNCTION document_chunks_have_one_version() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE
        kinds integer;
      BEGIN
        -- Deferred, so this sees the transaction's final state rather than the
        -- intermediate one the reindex passes through.
        SELECT count(DISTINCT version_number) INTO kinds
          FROM document_chunks
         WHERE document_id = COALESCE(NEW.document_id, OLD.document_id);
        IF kinds > 1 THEN
          RAISE EXCEPTION
            'document % left with chunks from % published versions',
            COALESCE(NEW.document_id, OLD.document_id), kinds
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END;
      $fn$;

    CREATE CONSTRAINT TRIGGER document_chunks_one_version
      AFTER INSERT OR UPDATE OR DELETE ON document_chunks
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION document_chunks_have_one_version();
  `);

  // Conversations, then their messages. `ai_messages` is the answer's audit
  // trail — citations included — so it gets the same database-enforced
  // immutability as document_versions. Unlike versions it is append-only rather
  // than write-once-per-row, which a BEFORE UPDATE trigger expresses exactly.
  pgm.createTable('ai_conversations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true, default: '' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ai_conversations', ['user_id', 'updated_at']);

  pgm.createTable(
    'ai_messages',
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      conversation_id: {
        type: 'uuid',
        notNull: true,
        references: 'ai_conversations(id)',
        onDelete: 'CASCADE',
      },
      ord: { type: 'integer', notNull: true },
      role: { type: 'text', notNull: true },
      text: { type: 'text', notNull: true },
      // Citations live on the message rather than in a join table because they
      // are part of the answer: same transaction, same immutability, no way to
      // attach a citation to a message it did not ship with. jsonb rather than
      // a uuid column because a citation carries its document, version, anchor
      // and heading text at answer time.
      citations: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {},
  );
  pgm.createIndex('ai_messages', ['conversation_id', 'ord'], { unique: true });

  pgm.sql(`
    CREATE FUNCTION ai_messages_are_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'ai_messages are append-only (message %)', OLD.id
          USING ERRCODE = 'check_violation';
      END;
      $fn$;

    CREATE TRIGGER ai_messages_no_update
      BEFORE UPDATE ON ai_messages
      FOR EACH ROW EXECUTE FUNCTION ai_messages_are_immutable();
  `);

  /**
   * The phase's central query.
   *
   * `c.document_id` is not merely returned, it is the join key for the ACL check
   * and for the "newest published version" predicate. Both are written to match
   * the rest of the codebase rather than to be merely plausible:
   * `can_access_document` is the same SQL function the websocket join and the
   * controllers use (PLAN §3.1: one thing decides access), and the newest
   * version is `(select max(number) …)` — the shape documents.controller and
   * the realtime gateway's snapshot already use, because two ways to name "the
   * published version" is two ways to disagree.
   *
   * ## why both the trigger and the version predicate
   *
   * They look redundant and are not: each catches a different stale state.
   * The trigger guarantees a document's chunks are never *mixed* across
   * versions. The predicate guarantees they are the *newest* version — which the
   * trigger cannot, because a document published at v2 whose reindex has not run
   * yet holds a clean, single-version set of v1 chunks.
   *
   * The predicate's effect during that window is worth being explicit about: it
   * makes the document **absent** from retrieval, not answered from superseded
   * content. That is the safer half of the trade. Serving v1 text after v2 was
   * published would quote content the current published document does not
   * contain, next to a citation whose reader lands on v2 and finds something
   * else — a confidently wrong answer. An absent document produces "the
   * documentation does not cover that", which is this phase's tested, honest
   * outcome. PLAN §2.5's rule for read paths is to resolve *current* published
   * content; a stale chunk is not that.
   *
   * A document that was published and then had its READ grant revoked likewise
   * drops out of the candidate set entirely. Neither absence is visible to the
   * caller, which is the point.
   *
   * Returns distance, not similarity, and lets the caller turn it into a score:
   * the threshold is a product decision (phase 5's config) and `1 - distance`
   * keeps that decision out of SQL.
   */
  pgm.sql(`
    CREATE FUNCTION ai_search_chunks(
      actor uuid,
      query_embedding halfvec(${VECTOR_DIMENSIONS}),
      limit_count integer DEFAULT 5
    ) RETURNS TABLE(chunk_id uuid, document_id uuid, document_title text, version_number integer,
                    anchor text, heading text, chunk_text text, distance double precision)
      LANGUAGE sql STABLE
      SET enable_seqscan = off
      SET hnsw.iterative_scan = 'relaxed_order'
    AS $fn$
      SELECT c.id,
             c.document_id,
             v.title,
             c.version_number,
             c.anchor,
             c.heading,
             c.text,
             (c.embedding <=> query_embedding)::double precision
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        JOIN document_versions v ON v.id = c.version_id
       WHERE can_access_document(actor, d.id, 'READ')
         AND c.version_number = (
               SELECT max(dv.number) FROM document_versions dv
                WHERE dv.document_id = c.document_id
             )
       ORDER BY c.embedding <=> query_embedding
       LIMIT limit_count;
      $fn$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION ai_search_chunks(uuid, halfvec(${VECTOR_DIMENSIONS}), integer);
    DROP TRIGGER IF EXISTS ai_messages_no_update ON ai_messages;
    DROP FUNCTION IF EXISTS ai_messages_are_immutable();
  `);
  pgm.dropTable('ai_messages');
  pgm.dropTable('ai_conversations');
  pgm.sql(`
    DROP TRIGGER IF EXISTS document_chunks_one_version ON document_chunks;
    DROP FUNCTION IF EXISTS document_chunks_have_one_version();
  `);
  pgm.dropTable('document_chunks');
};

exports.VECTOR_DIMENSIONS = VECTOR_DIMENSIONS;
