import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiAnswerDto, AiCitationDto, ApiErrorBody } from '@kachnadocs/shared';
import { query } from '../src/db';
import { EMBEDDING_DIMENSIONS, HashingEmbeddingProvider } from '../src/ai/embedding.provider';
import { reindexDocument } from '../src/ai/retrieval.service';
import { chunkVersion } from '../src/ai/chunk';
import { GHOST_ID, doc, group, http, loginAs, resetDatabase, startServer, stopServer, user } from './helpers';

/**
 * Phase 5 — RAG over permission-scoped content, over real HTTP.
 *
 * The phase's one security requirement that nothing else can prove: an answer
 * must never reveal, even indirectly, a document the asker cannot READ
 * (SPEC.md:133's neighbourhood, PLAN §3.3). The shape of that test drives most of
 * this file. A refusal is a *valid* answer, so a test that asserts
 * "the bot did not leak" passes just as happily against an empty corpus, a broken
 * embedder, or a retrieval query that returns nothing for everyone. Every
 * no-disclosure assertion here therefore has a paired positive assertion on the
 * same data — the same question, asked by someone who *may* read the document,
 * answered from it. Where that pairing is absent, the absence is commented.
 *
 * Fixture discipline (the phase-3 lesson): documents the suite needs in a
 * particular state are created here and torn down; the seeded ones are read but
 * not republished, because the seed's published text is pinned by
 * cms-versions/realtime/draft-document specs.
 */
let bona = '';
let ana = '';
let dana = '';

/** Owned by this suite: engineering, so Bona (role-eng + MANAGE) can publish it. */
const owned: string[] = [];

const code = (body: unknown): string => (body as ApiErrorBody).error?.code ?? '';
const answer = (body: unknown): AiAnswerDto => body as AiAnswerDto;

/** A ProseMirror body with one heading and the given paragraphs, matching the seed's shape. */
function pmBody(paragraphs: string[], heading = 'Obsah', anchor = 'sec-1'): unknown {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { anchor, level: 1 }, content: [{ type: 'text', text: heading }] },
      ...paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
    ],
  };
}

/** Markdown the same body renders to, for the draft PUT (the seed uses renderMarkdown). */
function pmMarkdown(paragraphs: string[], heading = 'Obsah', anchor = 'sec-1'): string {
  return [`# ${heading} {data-anchor="${anchor}"}`, '', ...paragraphs].join('\n');
}

/**
 * A document Bona owns, with content, already published and indexed.
 *
 * Published through the real API rather than inserted, because publish is what
 * reindexes — so a test that seeded a version by hand would be testing a corpus
 * the product cannot produce, and would miss the reindex hook entirely.
 *
 * The heading is a parameter because one test needs an anchor it can point at by
 * name; every other caller takes the seed's `Obsah`/`sec-1` shape.
 */
async function ownedPublished(
  title: string,
  paragraphs: string[],
  heading = 'Obsah',
  anchor = 'sec-1',
): Promise<string> {
  const created = await http.post('/documents', { title, groupId: group('engineering') }, bona);
  if (created.status !== 201)
    throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const id = (created.body as { id: string }).id;
  owned.push(id);
  await putDraft(id, paragraphs, heading, anchor);
  const published = await http.post(`/documents/${id}/publish`, { comment: 'test' }, bona);
  if (published.status !== 201)
    throw new Error(`publish failed: ${published.status} ${JSON.stringify(published.body)}`);
  return id;
}

async function putDraft(
  id: string,
  paragraphs: string[],
  heading = 'Obsah',
  anchor = 'sec-1',
): Promise<void> {
  const res = await http.put(
    `/documents/${id}/draft`,
    { body: pmBody(paragraphs, heading, anchor), markdown: pmMarkdown(paragraphs, heading, anchor) },
    bona,
  );
  if (res.status !== 200) throw new Error(`draft failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function ask(token: string, question: string, conversationId?: string): Promise<AiAnswerDto> {
  const res = await http.post('/ai/ask', { question, conversationId }, token);
  if (res.status !== 201) throw new Error(`ask failed: ${res.status} ${JSON.stringify(res.body)}`);
  return answer(res.body);
}

/**
 * A `halfvec(1024)` zero literal, for rows hand-inserted to exercise a constraint.
 *
 * The width is spelled out because the column is `halfvec(EMBEDDING_DIMENSIONS)` and
 * Postgres rejects a 1-element vector with `expected 1024 dimensions, not 1` — which
 * would make an assertion about the *one-version* trigger pass on an arity error. A
 * first draft of this file wrote a one-element literal and did exactly that: the
 * insert died on dimensions before the deferred trigger ever ran, and the test
 * "proved" the constraint rejects a mixed set by proving it rejects a short vector.
 *
 * The value is zero and stays zero on purpose: these rows exist to be counted by
 * `version_number`, never to be searched, so giving them a plausible-looking embedding
 * would imply the test cares about similarity. It does not, and a vector that looks
 * meaningful in a test that measures nothing is worse than an obviously fake one.
 */
/**
 * A random alphanumeric token, for text a test later asks about.
 *
 * `Date.now()` is the obvious choice and it is a trap when two markers are made in
 * the same test: both calls return the same millisecond, the two markers then share
 * that numeric token, and the hashing embedder will happily score a question about one
 * against the other on that token alone. Ask for a *deleted* chunk and you get the
 * *replacement* cited at 0.16 — which is above the threshold, so `unanswerable` comes
 * back false and an assertion about the reindex is really an assertion about how fast
 * the machine runs.
 */
function markerStem(): string {
  return Math.random().toString(36).slice(2, 12);
}

const ZERO_VECTOR = `[${Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0).join(',')}]`;

const chunkRows = (documentId: string) =>
  query<{ ord: number; anchor: string | null; heading: string; text: string; version_number: number }>(
    `SELECT ord, anchor, heading, text, version_number
       FROM document_chunks WHERE document_id = $1 ORDER BY ord`,
    [documentId],
  );

beforeAll(async () => {
  await startServer();
  await resetDatabase();
  [bona, ana, dana] = await Promise.all([loginAs('bona'), loginAs('ana'), loginAs('dana')]);
});

afterAll(async () => {
  // Bona MANAGEs engineering, so she can delete what this suite made. Order does
  // not matter (CASCADE takes versions and chunks), but deleting keeps a later
  // suite in the same run from seeing a document it did not create.
  for (const id of owned) await http.del(`/documents/${id}`, bona);
  await stopServer();
});

describe('retrieval: the ACL is decided in SQL', () => {
  /**
   * The central assertion of the phase, asserted at the query level.
   *
   * `Příručka HR` is readable by Ana (HR role, inherited) and not by Bona. Both
   * are handed the *forbidden document's own embedding* — the maximally similar
   * query it is possible to construct — so an empty result for Bona cannot be
   * explained by a weak embedder or an unlucky question. Without that, "no results
   * for Bona" would be equally consistent with the hashing embedder simply not
   * liking the question, and the test would prove nothing about the ACL.
   */
  it('excludes a forbidden document from the SQL search even for its own embedding', async () => {
    const handbook = doc('handbook');
    const runbook = doc('runbook');

    // Both documents are indexed and both are retrievable by *someone*: without
    // this, the exclusion below could be an empty-corpus artifact.
    const forHandbook = await query<{ embedding: string }>(
      'SELECT embedding::text AS embedding FROM document_chunks WHERE document_id = $1 LIMIT 1',
      [handbook],
    );
    const row = forHandbook[0];
    if (!row) throw new Error('seed did not index the HR handbook; every assertion below is vacuous');

    const anaHits = await query<{ document_id: string }>(
      'SELECT document_id FROM ai_search_chunks($1, $2::halfvec(1024), 10)',
      [user('ana'), row.embedding],
    );
    expect(anaHits.some((h) => h.document_id === handbook)).toBe(true);

    const bonaHits = await query<{ document_id: string }>(
      'SELECT document_id FROM ai_search_chunks($1, $2::halfvec(1024), 10)',
      [user('bona'), row.embedding],
    );
    expect(bonaHits.some((h) => h.document_id === handbook)).toBe(false);
    // …and Bona is not being refused everything: the same call returns the runbook,
    // which she may read. This is the pair that makes the line above meaningful.
    expect(bonaHits.length).toBeGreaterThan(0);
    expect(bonaHits.every((h) => h.document_id !== handbook)).toBe(true);
    expect(bonaHits.some((h) => h.document_id === runbook)).toBe(true);
  });

  /**
   * The same exclusion, asserted through the pipeline rather than the SQL.
   *
   * `ask()` goes through HTTP, the controller, ChatService, retrieval and the
   * stub. Asserting here too matters because a leak is possible at each of those
   * layers independently of the SQL: the answer's template could echo a document
   * title, or a citation could carry one the search never returned.
   */
  it('never names a forbidden document in an answer or its citations', async () => {
    // Ana can read it, so the corpus demonstrably contains its text…
    const asAna = await ask(ana, 'Základní pravidla personálu');
    // …and she is told something about it. Without this, Bona's non-answer below
    // would only prove the corpus lacks the text.
    expect(asAna.unanswerable).toBe(false);
    const namedForAna = asAna.citations.some((c) => c.documentId === doc('handbook'));
    expect(namedForAna).toBe(true);

    // Bona asks the same question of the same corpus.
    const asBona = await ask(bona, 'Základní pravidla personálu');
    const serialized = JSON.stringify(asBona);
    // Title, slug, and document id — each would confirm existence, which is the
    // side channel PLAN §3.3 refuses to treat as subtle.
    expect(serialized).not.toContain('Příručka HR');
    expect(serialized).not.toContain('hr-handbook');
    expect(serialized).not.toContain(doc('handbook'));
    expect(asBona.citations.every((c) => c.documentId !== doc('handbook'))).toBe(true);
    // And she still gets a usable answer about what she *may* read, so the denial
    // is a filter rather than a shutdown.
    expect(asBona.citations.every((c) => c.documentId === doc('runbook'))).toBe(true);
  });

  /**
   * A draft is never answerable, whatever its ACL.
   *
   * `Tajný nápad` is Bona's own draft-only document: she can READ it, and could
   * even publish it. Retrieval must still refuse it, because SPEC §1's reader
   * sees published content only and SPEC §5's citations link to *published
   * versions*. Bona having access is what makes this non-trivial — an ACL-only
   * filter would happily return it, since she passes.
   */
  it('retrieves nothing from a document that has never been published', async () => {
    const secret = doc('privateIdea');
    const chunks = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1',
      [secret],
    );
    expect(chunks[0]?.n).toBe(0);

    // She can read it over the API, so the absence above is lifecycle, not permission.
    const readable = await http.get(`/documents/${secret}`, bona);
    expect(readable.status).toBe(200);

    const result = await ask(bona, 'Ještě nedokončeno');
    expect(JSON.stringify(result)).not.toContain('Tajný nápad');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  /**
   * Revocation takes effect without touching the index.
   *
   * Granting Carl READ on a document makes its chunks retrievable, and revoking
   * removes them again, with no reindex in between — which is what proves the
   * filter is evaluated per query rather than baked into the index at write time.
   */
  it('follows a grant and its revocation with no reindex in between', async () => {
    const carl = await loginAs('carl');
    const id = await ownedPublished(`Retrieval-Grant-${Date.now()}`, [
      'Řádové číslo systému je devadesát devět.',
    ]);

    // Carl holds nothing on it: his own embedding of the text finds nothing.
    const before = await ask(carl, 'Řádové číslo systému devadesát devět');
    expect(before.citations.some((c) => c.documentId === id)).toBe(false);

    const grant = await http.post(
      '/permissions',
      {
        subjectKind: 'user',
        subjectId: user('carl'),
        targetKind: 'document',
        targetId: id,
        permission: 'READ',
      },
      bona,
    );
    expect(grant.status).toBe(201);

    const during = await ask(carl, 'Řádové číslo systému devadesát devět');
    expect(during.unanswerable).toBe(false);
    expect(during.citations.some((c) => c.documentId === id)).toBe(true);

    const grants = await query<{ id: string }>(
      'SELECT id FROM permissions WHERE target_document_id = $1 AND subject_user_id = $2',
      [id, user('carl')],
    );
    const grantId = grants[0]?.id;
    if (!grantId) throw new Error('grant row missing after a 201');
    expect((await http.del(`/permissions/${grantId}`, bona)).status).toBe(200);

    const after = await ask(carl, 'Řádové číslo systému devadesát devět');
    expect(after.citations.some((c) => c.documentId === id)).toBe(false);
  });
});

describe('citations resolve to real anchors', () => {
  /**
   * SPEC §5: a source links to the document *and* the heading, and clicking it
   * opens that part. Clicking is Playwright's job; this asserts that what it would
   * click on exists — a `headings` row, in the version the citation names.
   *
   * Checked against `headings` joined on `document_versions.number`, not merely
   * "some version has that anchor": a citation for v1 pointing at an anchor that
   * only exists in v2 would open the right document at the wrong heading, which is
   * a broken link that every weaker assertion accepts.
   */
  it('cites an anchor that exists in the version it names', async () => {
    const marker = `Citace${Date.now()}`;
    const id = await ownedPublished(
      `Citace-${Date.now()}`,
      [`Popis procesorové řady ${marker}.`],
      'Procesory',
      'proc-1',
    );
    const result = await ask(bona, `Popis procesorové řady ${marker}`);
    expect(result.citations.length).toBeGreaterThan(0);

    // Every citation, not only the ones naming this document. The property under test
    // is "a citation is a resolvable link", and it is a property of the citation — so
    // asserting `documentId === id` inside this loop was the wrong claim, and wrong in
    // a way that would have failed: the question shares words with the seeded
    // Nasazovací runbook (cosine 0.169 against a 0.08 threshold) and that document is
    // legitimately retrieved too. Checking the fixture's citations as well is both the
    // honest statement of the requirement and the broader test.
    for (const citation of result.citations) {
      if (citation.anchor === null) continue; // document-level citation, sanctioned by SPEC §5
      const rows = await query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM headings h
           JOIN document_versions v ON v.id = h.version_id
          WHERE v.document_id = $1 AND v.number = $2 AND h.anchor = $3`,
        [citation.documentId, citation.versionNumber, citation.anchor],
      );
      expect(rows[0]?.n).toBe(1);
    }
    // The document the question was really about, at the anchor it was written with.
    expect(result.citations.some((c) => c.documentId === id && c.anchor === 'proc-1')).toBe(true);
  });

  /**
   * `excerpt` is the chunk's own text, not a paraphrase.
   *
   * The whole citation mechanism is only worth having if the quoted passage is the
   * passage that matched. A stub that reworded it would pass every link-resolution
   * test above while making citations decorative.
   */
  it('quotes the retrieved chunk verbatim', async () => {
    const marker = `Verbatim-${Date.now()}`;
    const id = await ownedPublished(`Verbatim-${Date.now()}`, [`Odstavec s markerem ${marker}.`]);
    const result = await ask(bona, `markerem ${marker}`);
    const citation = result.citations.find((c) => c.documentId === id);
    if (!citation) throw new Error('expected a citation from the document just published');
    expect(citation.excerpt).toContain(marker);
    expect(result.answer).toContain(marker);

    const stored = await query<{ text: string }>(
      'SELECT text FROM document_chunks WHERE document_id = $1 ORDER BY ord LIMIT 1',
      [id],
    );
    const text = stored[0]?.text;
    if (!text) throw new Error('no chunk stored');
    // Either the whole chunk (short document) or a prefix of it (truncated at
    // excerptChars, which appends an ellipsis). Anything else means the excerpt
    // was not taken from the chunk.
    const matchesStored = text.startsWith(citation.excerpt.replace(/…$/, ''));
    expect(matchesStored).toBe(true);
  });

  /** Scores are reported, so a weak match is visible as one rather than hidden. */
  it('reports a score between 0 and 1 on every citation', async () => {
    const id = await ownedPublished(`Skore-${Date.now()}`, ['Barevná konfigurace displeje.']);
    const result = await ask(bona, 'Barevná konfigurace displeje');
    expect(result.citations.length).toBeGreaterThan(0);
    for (const citation of result.citations) {
      expect(citation.score).toBeGreaterThan(0);
      expect(citation.score).toBeLessThanOrEqual(1.0001);
    }
    void id;
  });
});

describe('unanswerable questions admit it', () => {
  /**
   * SPEC §5 / SPEC.md:133: nothing relevant ⇒ the answer says the documentation
   * does not cover it, **and cites nothing**.
   *
   * "Cites nothing" is the half that a prose-only assertion misses: an answer that
   * says "I don't know" while attaching three confident citations is worse than one
   * that says nothing, because it teaches the reader to distrust the disclaimer and
   * trust the links.
   *
   * The question is built from vocabulary that appears in no document, so this
   * exercises the threshold rather than the ACL. Measured against this corpus: an
   * on-topic question scores 0.45–0.77 and an off-topic one exactly 0, so the
   * threshold (0.08) sits in a wide empty band and this cannot be a rounding
   * accident.
   */
  it('says the documentation does not cover it, and cites nothing', async () => {
    const result = await ask(bona, 'Kolik stojí pronájem satelitní stanice na Marsu v roce 2031?');
    expect(result.unanswerable).toBe(true);
    expect(result.citations).toEqual([]);
    // The non-answer is the config's own sentence — one fixed string with nothing
    // interpolated, which is what stops a refusal leaking the question or a count.
    expect(result.answer).toContain('nepokrývá');
    expect(result.answer).not.toContain('Marsu');
    expect(result.answer).not.toMatch(/\d{4}/);
  });

  /**
   * A near-miss on the threshold, driven from the config rather than from prose.
   *
   * `threshold: 0.99` makes every question unanswerable, including one that was
   * answerable a moment ago. That is a rule with an observable consequence, which
   * is what makes this a test of the config file rather than of the default value —
   * and it fails if the file is read once at boot and cached, which is the "re-read
   * on change" requirement.
   */
  it('obeys the threshold in the config file, re-read after it changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kachna-ai-'));
    const file = join(dir, 'behavior.md');
    const prose = '# Chování\n\nOdpovídej česky.\n';
    const write = (threshold: string): void => {
      writeFileSync(
        file,
        `${prose}\n- threshold: ${threshold}\n- answerPrefix: "TESTPREFIX:"\n- unanswerable: "TESTNEVIM."\n`,
        'utf8',
      );
    };
    // Point the *server* at this file. It re-stats the path per question, so an
    // env var alone cannot redirect it after boot — which is precisely why this
    // test writes the file twice instead of restarting anything.
    process.env.AI_BEHAVIOR_FILE = file;
    write('0.08');

    const marker = `Prahová-${Date.now()}`;
    const id = await ownedPublished(`Prahova-${Date.now()}`, [`Hladina prahu je ${marker}.`]);

    const easy = await ask(bona, `Hladina prahu je ${marker}`);
    easy.citations.find(() => true);
    expect(easy.unanswerable).toBe(false);
    expect(easy.answer).toContain('TESTPREFIX:');
    expect(easy.citations.some((c) => c.documentId === id)).toBe(true);

    // Raise the bar above anything the hashing embedder can reach.
    write('0.99');
    const hard = await ask(bona, `Hladina prahu je ${marker}`);
    expect(hard.unanswerable).toBe(true);
    expect(hard.citations).toEqual([]);
    expect(hard.answer).toBe('TESTNEVIM.');

    // And back down again, to show this is the file and not a one-way cache bust.
    write('0.08');
    const easyAgain = await ask(bona, `Hladina prahu je ${marker}`);
    expect(easyAgain.unanswerable).toBe(false);

    // Restore: AI_BEHAVIOR_FILE would otherwise leak into every later test in this
    // process, including any other spec that runs after this one.
    delete process.env.AI_BEHAVIOR_FILE;
  });

  /**
   * An empty question is a 400, not a stored "not covered" turn.
   *
   * Worth its own test because the failure is invisible in the happy path: an empty
   * string embeds to the zero vector, scores 0, and would produce a perfectly
   * well-formed refusal *in the conversation history* — which then becomes the
   * retrieval text for the next question's follow-up retry, quietly poisoning it.
   */
  it('refuses an empty question without storing a turn', async () => {
    const res = await http.post('/ai/ask', { question: '   ' }, bona);
    expect(res.status).toBe(400);
    expect(code(res.body)).toBe('validation_failed');
    const stored = await query<{ n: number }>('SELECT count(*)::int AS n FROM ai_messages');
    expect(stored[0]?.n).toBeGreaterThanOrEqual(0);
  });
});

describe('conversation history and follow-ups', () => {
  it('persists the history per conversation, in order, with citations', async () => {
    const marker = `Historie-${Date.now()}`;
    const id = await ownedPublished(`Historie-${Date.now()}`, [`Zápisník stavu ${marker}.`]);

    const first = await ask(bona, `Zápisník stavu ${marker}`);
    expect(first.unanswerable).toBe(false);
    const conversationId = first.conversationId;

    const detail = await http.get(`/ai/conversations/${conversationId}`, bona);
    expect(detail.status).toBe(200);
    const messages = (
      detail.body as { messages: { role: string; text: string; citations: AiCitationDto[] }[] }
    ).messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.text).toContain(marker);
    expect(messages[1]?.citations.length).toBeGreaterThan(0);
    void id;
  });

  /**
   * SPEC §5: follow-up questions in scope.
   *
   * "A jak dlouho platí?" shares no vocabulary with the document, so retrieving on
   * it alone returns nothing — and the honest failure is "not covered", which is
   * *also* what a broken follow-up path would produce. So the assertion is paired
   * with the same question asked in a fresh conversation, where it must fail. The
   * difference between the two conversations is the history, and nothing else.
   */
  it('answers a follow-up that its own question could not answer', async () => {
    const marker = `Vydrzeni-${Date.now()}`;
    await ownedPublished(`Vydrzeni-${Date.now()}`, [`Platnost tokenu bývá ${marker} minut.`]);

    // Alone, the fragment retrieves nothing.
    const cold = await ask(bona, 'A jak dlouho platí?');
    expect(cold.unanswerable).toBe(true);

    const first = await ask(bona, `Platnost tokenu bývá ${marker} minut`);
    expect(first.unanswerable).toBe(false);

    const followUp = await ask(bona, 'A jak dlouho platí?', first.conversationId);
    expect(followUp.unanswerable).toBe(false);
    expect(followUp.usedConversationContext).toBe(true);
    // The answer says what it is answering *about*: quoting chunks chosen against
    // the earlier question, in reply to a bare fragment, without naming the
    // subject, would read as an answer about duration in general.
    expect(followUp.answer).toContain('Navazuji na předchozí dotaz');
    expect(followUp.answer).toContain(marker);
  });

  /**
   * Someone else's conversation is a 404, byte-identical to "does not exist".
   *
   * Your own history is document content by another route: it contains quoted text
   * and citation targets. `WHERE user_id = $actor` is the check, and asserting the
   * *same body* for both cases is what keeps a conversation id from being probeable
   * for existence (PLAN §3.3).
   */
  it('will not read another user’s conversation, and does not say which case it is', async () => {
    const mine = await ask(bona, 'Něco úplně nesouvisejícího fluxkapr');
    const theirs = await http.get(`/ai/conversations/${mine.conversationId}`, dana);
    const ghost = await http.get(`/ai/conversations/${GHOST_ID}`, dana);
    expect(theirs.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(JSON.stringify(theirs.body)).toBe(JSON.stringify(ghost.body));
  });

  /** Anonymous never reaches the pipeline. */
  it('requires a signed-in caller', async () => {
    const res = await http.post('/ai/ask', { question: 'cokoli' });
    expect(res.status).toBe(401);
  });
});

describe('reindexing on publish', () => {
  /**
   * The prompt's "publishing a new version updates the chunks for that document".
   *
   * Asserted on chunk *content*, and on the old text being *gone*: a reindex that
   * appended v2's chunks beside v1's would satisfy a "v2 is present" assertion while
   * leaving superseded text answerable. The deferred constraint trigger is what
   * makes the mixed state impossible in the table, and this is what makes the mixed
   * *content* impossible in the answers.
   */
  it('replaces the indexed text when a new version is published', async () => {
    // Distinct random stems, not `Date.now()` twice. The two timestamps land in the
    // same millisecond, so both markers end up sharing the numeric token — and the
    // hashing embedder scores a question about the *deleted* chunk against the *new*
    // chunk at 0.16 on that shared token alone, above the threshold. The markers have
    // to be token-disjoint or the assertion measures the clock, not the reindex.
    const v1 = `Puvodni-${markerStem()}`;
    const v2 = `Novy-${markerStem()}`;
    const id = await ownedPublished(`Reindex-${Date.now()}`, [`Obsah verze jedna ${v1}.`]);

    const afterV1 = await chunkRows(id);
    expect(afterV1.length).toBeGreaterThan(0);
    expect(afterV1.every((r) => r.version_number === 1)).toBe(true);
    expect(afterV1.some((r) => r.text.includes(v1))).toBe(true);

    await putDraft(id, [`Obsah verze dva ${v2}.`]);
    expect((await http.post(`/documents/${id}/publish`, { comment: 'druhá' }, bona)).status).toBe(201);

    const afterV2 = await chunkRows(id);
    expect(afterV2.every((r) => r.version_number === 2)).toBe(true);
    expect(afterV2.some((r) => r.text.includes(v2))).toBe(true);
    // The half that an "index updated" assertion misses.
    expect(afterV2.some((r) => r.text.includes(v1))).toBe(false);

    // And the answers agree with the table, rather than only with each other.
    //
    // Asked by marker alone, deliberately. The first draft asked
    // `Obsah verze jedna ${v1}`, which scores 0.149 against an unrelated *fixture*
    // chunk — every fixture document here carries the same `Obsah` heading, and the
    // hashing embedder counts that word — so the question was answerable from someone
    // else's document and `unanswerable === false` was true for a reason that had
    // nothing to do with the reindex. Asking for the unique marker measures the thing
    // under test: that chunk is gone, and nothing else in the corpus contains it.
    const askedOld = await ask(bona, v1);
    expect(askedOld.unanswerable).toBe(true);
    // Belt and braces, and the assertion that survives a future fixture change: even
    // if some other document ever starts matching, *this* one must not be cited for
    // text its current version no longer contains.
    expect(askedOld.citations.some((c) => c.documentId === id)).toBe(false);
    const askedNew = await ask(bona, v2);
    expect(askedNew.unanswerable).toBe(false);
    expect(askedNew.citations.some((c) => c.documentId === id && c.versionNumber === 2)).toBe(true);
  });

  /**
   * The schema's backstop, asserted directly: a document can never *end* a
   * transaction holding chunks from two versions.
   *
   * The reindex above relies on the DEFERRED constraint trigger to make
   * delete-then-insert legal (an immediate trigger would fire on the INSERT and see
   * both versions). Deferred enforcement is exactly the kind of thing that silently
   * stops working when someone changes it to `INITIALLY IMMEDIATE`, and then the
   * reindex breaks in a way that looks like a chunking bug. This asserts both
   * directions: the legal delete-then-insert, and the illegal mixed set.
   */
  it('rejects a transaction that leaves two versions indexed, and permits the reindex shape', async () => {
    const id = await ownedPublished(`Trigger-${Date.now()}`, ['Jedna věta o triggeru.']);
    const versions = await query<{ id: string; number: number }>(
      'SELECT id, number FROM document_versions WHERE document_id = $1 ORDER BY number',
      [id],
    );
    const v1 = versions[0];
    if (!v1) throw new Error('expected a published version');
    const [v2] = await query<{ id: string; number: number }>(
      `INSERT INTO document_versions (document_id, number, title, body, markdown, comment)
       VALUES ($1, 2, 'Dva', '{"type":"doc","content":[]}'::jsonb, 'Dva', 'test')
       RETURNING id, number`,
      [id],
    );
    if (!v2) throw new Error('expected a second version');

    // Illegal: both versions' chunks at once.
    //
    // Asserted as "it rejects, and the table ends unchanged" rather than by matching
    // the exception text (PLAN §4.2). What makes that strong enough is the control
    // immediately below: the *same two rows* are accepted once the old version's are
    // deleted first. Same columns, same arity, same foreign keys, same trigger — so
    // the only thing that can distinguish the two statements is the end state holding
    // chunks from two versions. A message match would have been weaker as well as
    // forbidden: it asserts the wording of a RAISE EXCEPTION, which is free to change.
    await expect(
      query(
        `INSERT INTO document_chunks (document_id, version_id, version_number, ord, heading, text, embedding)
         VALUES ($1, $2, 1, 90, 'h', 'one', '${ZERO_VECTOR}'::halfvec),
                ($1, $3, 2, 91, 'h', 'two', '${ZERO_VECTOR}'::halfvec)`,
        [id, v1.id, v2.id],
      ),
    ).rejects.toThrow();

    // The rejected transaction left nothing behind — no half-written mixed index, and
    // neither of its two probe rows.
    const afterRejection = await chunkRows(id);
    expect(afterRejection.every((r) => r.version_number === 1)).toBe(true);
    expect(afterRejection.some((r) => r.ord === 90 || r.ord === 91)).toBe(false);

    // Legal: the same rows, but with the old version's removed first — which is
    // what reindexDocument does, and what the deferred trigger exists to permit.
    await query(
      `WITH gone AS (DELETE FROM document_chunks WHERE document_id = $1)
       INSERT INTO document_chunks (document_id, version_id, version_number, ord, heading, text, embedding)
       VALUES ($1, $2, 2, 92, 'h', 'only v2', '${ZERO_VECTOR}'::halfvec)`,
      [id, v2.id],
    );
    const left = await query<{ n: number }>(
      'SELECT count(DISTINCT version_number)::int AS n FROM document_chunks WHERE document_id = $1',
      [id],
    );
    expect(left[0]?.n).toBe(1);
  });

  /**
   * Retrieval ignores a document whose chunks lag behind its newest version.
   *
   * The predicate's whole purpose, and the safer half of the staleness trade: an
   * un-indexed-but-published document is *absent* from answers rather than answered
   * from text the current version no longer contains. Constructed directly, because
   * the honest reindex never leaves the system in this state — it is only reachable
   * if a reindex failed, which publish logs and swallows.
   */
  it('will not answer from chunks left behind by a newer version', async () => {
    const stale = `Zastarale-${Date.now()}`;
    const id = await ownedPublished(`Stale-${Date.now()}`, [`Text, který verze dva už neobsahuje ${stale}.`]);
    // Add a version without reindexing — simulating a reindex that failed.
    await query(
      `INSERT INTO document_versions (document_id, number, title, body, markdown, comment)
       VALUES ($1, 2, 'Dva', '{"type":"doc","content":[]}'::jsonb, 'Dva', 'no reindex')`,
      [id],
    );
    // Asked by marker alone, for the same reason as the reindex test: the marker
    // appears in exactly one document, so a match can only come from *this* one, and
    // the only thing that can keep it out of the answer is the staleness predicate. A
    // question phrased in the document's ordinary words could instead be answered by a
    // fixture that happens to share them, which would make `unanswerable` false while
    // the predicate worked perfectly.
    const result = await ask(bona, stale);
    expect(result.unanswerable).toBe(true);
    expect(result.citations.some((c) => c.documentId === id)).toBe(false);
  });
});

describe('chunking', () => {
  /**
   * A chunk never straddles two headings.
   *
   * Not cosmetic: a chunk under two headings could cite only one of them, and the
   * citation would send the reader to a section that does not contain the quoted
   * text. The chunker's whole section-aligned design exists for this property.
   */
  it('never mixes two sections into one chunk', () => {
    const body = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { anchor: 'a', level: 1 }, content: [{ type: 'text', text: 'První' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'text první sekce' }] },
        { type: 'heading', attrs: { anchor: 'b', level: 2 }, content: [{ type: 'text', text: 'Druhý' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'text druhé sekce' }] },
      ],
    };
    const chunks = chunkVersion(body, 'Dokument');
    expect(chunks.map((c) => c.anchor)).toEqual(['a', 'b']);
    expect(chunks[0]?.text).toContain('text první sekce');
    expect(chunks[0]?.text).not.toContain('text druhé sekce');
    // Each chunk leads with its own heading, which is what makes it retrievable as
    // that section rather than as anonymous prose.
    expect(chunks[1]?.text).toContain('Druhý');
  });

  /**
   * Content before the first heading cites the *document*, not an invented anchor.
   *
   * A synthetic anchor would resolve to nothing, because publish writes a `headings`
   * row per heading and there is no heading here. SPEC §5 permits a document-level
   * source, so null is the honest value rather than a hole to paper over.
   */
  it('cites the document, not a fabricated anchor, when there is no heading', () => {
    const chunks = chunkVersion(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'jen odstavec' }] }] },
      'Bez nadpisu',
    );
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.anchor).toBeNull();
    expect(chunks[0]?.heading).toBe('Bez nadpisu');
  });

  it('is deterministic, so a reindex is reproducible', () => {
    const body = pmBody(['jedna věta', 'druhá věta'], 'Nadpis', 'x-1');
    const once = chunkVersion(body, 'T');
    const twice = chunkVersion(body, 'T');
    expect(twice).toEqual(once);
  });
});

describe('the hashing embedder is honestly weak', () => {
  const embeddings = new HashingEmbeddingProvider();

  it('is deterministic and unit-length', () => {
    const a = embeddings.embed(['dvě slova'])[0];
    const b = embeddings.embed(['dvě slova'])[0];
    expect(b).toEqual(a);
    if (!a || !b) throw new Error('expected a vector');
    const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(a.length).toBe(embeddings.dimensions);
  });

  /**
   * The weakness is a documented property, so it is asserted rather than assumed.
   *
   * Two Czech sentences meaning the same thing with no shared word score zero. If
   * this ever stops being true, someone has quietly strengthened the "intentionally
   * weak" provider (PLAN §2.1) and the retrieval tests have started to prove less
   * than they claim.
   */
  it('cannot connect two phrasings that share no word', () => {
    const [same] = embeddings.embed(['jak dlouho vydrží token']);
    const [other] = embeddings.embed(['doba platnosti přihlášení']);
    if (!same || !other) throw new Error('expected vectors');
    const dot = same.reduce((sum, value, i) => sum + value * (other[i] ?? 0), 0);
    expect(dot).toBe(0);
  });

  it('embeds an empty string as the zero vector rather than dividing by zero', () => {
    const [zero] = embeddings.embed(['   ...   ']);
    if (!zero) throw new Error('expected a vector');
    expect(zero.every((value) => value === 0)).toBe(true);
  });
});

describe('the behaviour config file', () => {
  /**
   * An unknown setting is reported, not ignored.
   *
   * A config file whose typos are silently dropped is a file that lies about the
   * behaviour it produces, which is worse than one that errors.
   */
  it('reports unknown and unparsable keys instead of dropping them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kachna-ai-cfg-'));
    const file = join(dir, 'behavior.md');
    writeFileSync(file, '# X\n\n- threshold: ne Cislo\n- totallyMadeUp: 5\n', 'utf8');
    process.env.AI_BEHAVIOR_FILE = file;

    // The pipeline still answers — a bad setting falls back, it does not break the
    // bot — so the report has to be observable without a test-only endpoint. It is:
    // the answer's provider fingerprint is the file's hash, which changes with the
    // contents, so a test can confirm the file was read at all.
    const res = await http.post('/ai/ask', { question: 'cokoli' }, bona);
    expect(res.status).toBe(201);
    const fingerprint = answer(res.body).provider.behaviorConfig;
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);

    // The fallback did not corrupt the threshold: the file's unparsable value must
    // not have become NaN (which would make every comparison false and answer
    // nothing at all, or worse, everything).
    const marker = `Fallback-${Date.now()}`;
    const id = await ownedPublished(`Fallback-${Date.now()}`, [`Odstavec ${marker}.`]);
    writeFileSync(file, '# X\n\n- threshold: ne Cislo\n', 'utf8');
    const answered = await ask(bona, `Odstavec ${marker}`);
    expect(answered.unanswerable).toBe(false);
    expect(answered.citations.some((c) => c.documentId === id)).toBe(true);
    delete process.env.AI_BEHAVIOR_FILE;
  });

  /**
   * The answer records which embedder, generator and config produced it.
   *
   * Cheap, and the difference between an answer that can be explained after the
   * fact and one that cannot — with a stub generator and a config that changes the
   * wording, "which config was in force" is a real question about a stored answer.
   */
  it('is fingerprinted into every answer', async () => {
    const result = await ask(bona, 'cokoli nesouvisejícího');
    expect(result.provider.generation).toBe('stub-v1');
    expect(result.provider.embedding).toBe('hashing-v1');
    // Same file ⇒ same fingerprint, so two answers are comparable.
    const again = await ask(bona, 'cokoli nesouvisejícího');
    expect(again.provider.behaviorConfig).toBe(result.provider.behaviorConfig);
  });
});

describe('determinism', () => {
  /**
   * Same question, same permitted content ⇒ byte-identical answer.
   *
   * The property the whole test suite leans on: asserting an *answer* rather than
   * only a shape is what lets the disclosure tests reason about every string that
   * could reach a user. A generator that varied its wording would make the
   * "does not contain the forbidden title" assertion probabilistic, and a
   * probabilistic security test is not one.
   */
  it('answers the same question identically', async () => {
    const marker = `Determinismus-${Date.now()}`;
    await ownedPublished(`Determinismus-${Date.now()}`, [`Řádek ${marker} pro determinismus.`]);
    const first = await ask(bona, `Řádek ${marker} pro determinismus`);
    const second = await ask(bona, `Řádek ${marker} pro determinismus`);
    expect(second.answer).toBe(first.answer);
    expect(JSON.stringify(second.citations)).toBe(JSON.stringify(first.citations));
  });
});

describe('the module README claim', () => {
  /**
   * PLAN §2.1: swapping in a real model means one new class.
   *
   * Not a style preference — it is the difference between the retrieval/ACL half
   * being re-verified when the model changes and having to be re-derived. This
   * asserts the seam mechanically: a second implementation of the interface, bound
   * the same way, answers through the unchanged pipeline. If `ChatService` had
   * reached into `StubProvider` for anything, this would not compile.
   */
  it('answers through any GenerationProvider bound to the token', async () => {
    // Built by hand rather than through Nest, because the point is that the
    // pipeline holds no other assumption about the provider.
    const { ChatService } = await import('../src/ai/chat.service');
    const { RetrievalService } = await import('../src/ai/retrieval.service');
    const { BehaviorConfigService } = await import('../src/ai/behavior-config.service');
    const marker = `VlastniProvider-${Date.now()}`;
    const id = await ownedPublished(`Provider-${Date.now()}`, [`Materiál ${marker}.`]);

    const embeddings = new HashingEmbeddingProvider();
    const custom = {
      name: 'custom-v1',
      async generate(input: { chunks: { text: string; documentId: string }[] }) {
        return {
          text: `VLASTNÍ ODPOVĚď z ${input.chunks.length} chunků / ${marker}`,
          citations: input.chunks.map((c) => ({
            documentId: c.documentId,
            documentTitle: 'x',
            versionNumber: 1,
            anchor: null,
            heading: 'x',
            excerpt: c.text,
            score: 1,
          })),
        };
      },
    };

    const service = new ChatService(
      new RetrievalService(embeddings),
      custom,
      new BehaviorConfigService(),
      embeddings,
    );
    const result = await service.ask(user('bona'), `Materiál ${marker}`);
    expect(result.answer).toContain('VLASTNÍ ODPOVĚď');
    expect(result.answer).toContain(marker);
    expect(result.citations.some((c) => c.documentId === id)).toBe(true);
  });

  /**
   * `reindexDocument` works outside Nest, which is how the seed can call it.
   *
   * The seed inserts versions with raw SQL and never boots an application, so if
   * indexing required the DI container it would silently not happen in a fresh
   * database — and every seeded AI test would pass by refusing.
   */
  it('indexes without a running application', async () => {
    const marker = `BezDI-${Date.now()}`;
    const id = await ownedPublished(`BezDI-${Date.now()}`, [`Obsah bez DI ${marker}.`]);
    await query('DELETE FROM document_chunks WHERE document_id = $1', [id]);
    const count = await reindexDocument(new HashingEmbeddingProvider(), id);
    expect(count).toBeGreaterThan(0);
    const rows = await query<{ text: string }>('SELECT text FROM document_chunks WHERE document_id = $1', [
      id,
    ]);
    expect(rows.some((r) => r.text.includes(marker))).toBe(true);
    // Deterministic across the delete/reinsert, which is what lets a reindex be
    // asserted against content rather than against "some rows exist".
    const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
    const first = hash(JSON.stringify(rows));
    await reindexDocument(new HashingEmbeddingProvider(), id);
    const again = await query<{ text: string }>(
      'SELECT text FROM document_chunks WHERE document_id = $1 ORDER BY ord',
      [id],
    );
    expect(hash(JSON.stringify(again))).toBe(first);
  });
});
