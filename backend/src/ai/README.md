# AI module — RAG over permission-scoped content

Phase 5. Pipeline, in the order SPEC.md §5 states it:

```
autorizace → vyhledání pouze povoleného obsahu → RAG → generování → odpověď + citované zdroje
```

PLAN.md §2.1 splits this module in half and the split is the first thing to
understand about it:

| Half | Status | Where |
|---|---|---|
| Chunking, embeddings, HNSW index, similarity search, ACL filtering, threshold | **real** | `chunk.ts`, `embedding.provider.ts`, `retrieval.service.ts`, `1740000009000_ai_retrieval.js` |
| Answer generation | **stubbed** | `generation.provider.ts` → `StubProvider` |

Stubbing the LLM must not become stubbing the RAG, so the retrieval half is not a
mock: the `halfvec(1024)` column, the HNSW index and the cosine search are
genuinely what answer questions.

## Adding a real model = one new class

`GenerationProvider` is an interface and `StubProvider` is the only implementation
in scope. **Swapping in a real model means one new class implementing
`GenerationProvider`, plus changing the `GENERATION_PROVIDER` binding in
`ai.module.ts`.** No change to `ChatService`, `AiController`, retrieval, message
persistence, or any test — those consume the interface by token and never name the
stub. `EmbeddingProvider` works the same way via `EMBEDDING_PROVIDER`.

Two rules a real provider has to keep, both of which are security properties
rather than style:

1. **The model may receive only the chunks it was handed** (plus the actor's own
   question and conversation). A model that also gets documents it did not
   retrieve has bypassed the ACL through a side door no SQL predicate can close.
2. **Retrieval stays in SQL.** `ai_search_chunks(actor, embedding, limit)` applies
   `can_access_document` inside its own `WHERE` clause — PLAN §3.2 requires the
   filter in the query, and PLAN §3.1 allows exactly one thing to decide access.
   A TypeScript pre-filter over a list of permitted ids would be a rival
   implementation of the ACL.

`ai_search_chunks` also carries `SET hnsw.iterative_scan = 'relaxed_order'`, which
is not tuning: an HNSW scan returns its top-k *before* the ACL predicate is
applied, so when the nearest neighbours all belong to forbidden documents the
post-filter empties the result and the bot says "not covered" about content the
reader is permitted to read. Iterative scan keeps draining the index until the
limit is satisfied. See the migration header — that includes the measured case
(500 forbidden chunks nearer than the single permitted one: 0 rows without it, 1
row with it).

## Files

| File | Responsibility |
|---|---|
| `chunk.ts` | Splits a published version into section-aligned chunks. A chunk never straddles two headings, so every citation can name one honestly. |
| `embedding.provider.ts` | `EmbeddingProvider` interface + `HashingEmbeddingProvider` (deterministic, offline, **intentionally weak** — see below). |
| `retrieval.service.ts` | `reindexDocument` (publish + seed) and `search`/`searchByVector` (the ACL-filtered query). |
| `generation.provider.ts` | `GenerationProvider` interface + `StubProvider`. |
| `behavior-config.service.ts` | The behaviour rules file: prose for a model, `- key: value` settings the pipeline executes. |
| `chat.service.ts` | The pipeline: ownership check → retrieval → threshold → follow-up retry → generation → persist turn. |
| `ai.controller.ts` | `POST /api/ai/ask`, `GET /api/ai/conversations[/:id]`. Explains why no `@RequirePermission` here. |

## The behaviour config

`config/ai-behavior.md` (override with `AI_BEHAVIOR_FILE`). Prose in it is the
instructions a real model would read; `- key: value` bullets are the subset this
build can execute without a model, which is what makes "editing the config changes
the bot's behaviour" testable today. Re-read on change — stat'd per question,
re-parsed when mtime or size differs, so an edit needs no restart. Format and
recognised keys are documented in `behavior-config.service.ts` and in that file.

Unrecognised or unparsable keys are logged and reported in
`BehaviorRules.unknownKeys`/`invalidKeys` rather than dropped: a silently ignored
setting is a config file that lies about the behaviour it produces.

## `HashingEmbeddingProvider` is deliberately bad at its job

Bag-of-words feature hashing over unigrams and bigrams, L2-normalised. Deterministic,
offline, no API key. It cannot tell that "jak dlouho vydrží token" and "doba
platnosti přihlášení" ask the same thing — it scores lexical overlap and nothing
else.

That weakness is the reason it is in the plan (PLAN §2.1): a similarity test that
passes against *this* proves the plumbing works without depending on a model's
semantics, and nobody gets to read a green retrieval test as evidence of answer
quality. **Do not report retrieval quality from it.** Its default threshold
(`0.08`) is calibrated against it; a real embedder needs a different number, which
is a config edit rather than a code change.

## Answerability, not confidence

When nothing clears the threshold the answer is one fixed sentence from the config
file, with **nothing interpolated into it** — no echo of the question, no document
count, no "did you mean". A denial that mentions the thing it is denying is the
leak this module is centrally tested for (SPEC.md:133, PLAN §3.3).
`StubProvider` keeps its own empty-input guard so that property does not depend on
one caller remembering the threshold.
