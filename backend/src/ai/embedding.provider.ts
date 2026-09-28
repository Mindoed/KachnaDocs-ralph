/**
 * Embeddings, and the contract any provider has to satisfy.
 *
 * PLAN §2.1 splits this phase in two: the retrieval half is real, the generation
 * half is stubbed. This file belongs to the real half — the vectors are genuinely
 * computed, stored in a genuine `halfvec` column, and genuinely searched by an
 * HNSW index — and `HashingEmbeddingProvider` is genuinely a *bad* embedder, on
 * purpose. It is bag-of-words with a hash for a vocabulary, so "similarity" here
 * means lexical overlap and nothing else: it cannot tell that "jak dlouho vydrží
 * token" and "doba platnosti přihlášení" ask the same thing. That is the point. A
 * test that passes against a real model proves retrieval works; a test that
 * passes against *this* proves retrieval works without quietly depending on a
 * model's semantics, and nobody gets to read a green similarity test as evidence
 * of answer quality. Swapping in a real embedder is one new class implementing
 * `EmbeddingProvider` with the same `dimensions`.
 */

/** Turns text into fixed-length numeric vectors. */
export interface EmbeddingProvider {
  /** Name in answers' metadata, so an answer records which embedder produced it. */
  readonly name: string;
  /**
   * Length of every vector this provider returns. The stored column type and the
   * HNSW operator class are fixed at this width, so a provider whose dimensions
   * differ cannot be dropped in without a migration — saying so in the type is
   * cheaper than discovering it in an INSERT.
   */
  readonly dimensions: number;
  embed(texts: readonly string[]): number[][];
}

/** Fixed width, for the same reason the migration fixes it: schema is not negotiable per-call. */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Nest injection token for `EmbeddingProvider`.
 *
 * Lives here rather than in the module because the consumers name it in
 * `@Inject(...)`, and an interface's token should be discoverable from the file
 * that declares the interface. An interface erases at compile time, so without a
 * token Nest has nothing to resolve at runtime.
 */
export const EMBEDDING_PROVIDER = 'kachnadocs:embedding-provider';

/**
 * FNV-1a, 32-bit.
 *
 * Not cryptographic and not a "good" hash for hashing-out collisions at this
 * scale — it is stable across processes and Node versions, which is the property
 * that matters: a stored embedding must be reproducible, or a reindex cannot be
 * asserted against a previous one and a restart silently changes retrieval.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Lowercased word tokens, diacritics kept.
 *
 * Deliberately *not* stemmed or de-accented: with a hashing vocabulary,
 * "token" and "tokeny" are different features, which makes this embedder weaker
 * than a Czech stemmer would. Left that way on purpose — a stemming layer would
 * make the hashing provider look better than it is, and the weakness is the
 * reason it is in the plan. If retrieval quality ever needs to improve, the
 * change belongs in a new provider, not in quietly strengthening this one.
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

/**
 * Deterministic, offline, no API key, no network — and intentionally weak.
 *
 * Feature hashing over word unigrams and bigrams: each token picks a bucket from
 * its hash, and a second bit of the same hash picks the bucket's sign. Signs keep
 * unrelated texts near zero cosine instead of uniformly positive, which is what
 * makes the answer's "nothing relevant" threshold meaningful rather than a guess.
 * The vector is L2-normalised so cosine and dot product coincide and the SQL side
 * only ever needs one operator.
 *
 * Bigrams are why a short question can match a long chunk at all: unigrams alone
 * make a two-word query's cosine dominated by every document containing those
 * words. Note that this is still lexical — see this file's header.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hashing-v1';

  readonly dimensions = EMBEDDING_DIMENSIONS;

  embed(texts: readonly string[]): number[][] {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const words = tokens(text);
    const grams = [...words];
    for (let i = 0; i + 1 < words.length; i += 1) grams.push(`${words[i]} ${words[i + 1]}`);

    for (const gram of grams) {
      const hash = fnv1a(gram);
      const bucket = hash % this.dimensions;
      // A different bit decides the sign, so bucket and sign are not correlated
      // through the low bits of the same value.
      const sign = (hash >>> 16) & 1 ? 1 : -1;
      vector[bucket] = (vector[bucket] ?? 0) + sign;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    // An empty (or purely punctuation) text has no features. Returning the zero
    // vector rather than dividing by zero keeps it storable, and cosine against
    // it is 0 — which is exactly "this says nothing", and lands below any
    // threshold the caller applies.
    if (norm === 0) return vector;
    return vector.map((value) => value / norm);
  }
}

/** pgvector's text literal. `halfvec(1024)` is built from a string; there is no JS driver type. */
export function vectorToSqlLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Cosine similarity in TypeScript, for the unit tests that assert the embedder's
 * own behaviour.
 *
 * Deliberately not used by retrieval — SQL does that with `<=>` over the indexed
 * column — but a test that asserted retrieval scores purely through the database
 * could not tell a broken embedder apart from a broken query. Both vectors are
 * already unit length, so the dot product *is* the cosine.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
