/**
 * The chat pipeline, in the order SPEC §5's expected behaviour names it:
 *
 * ```
 * autorizace → vyhledání pouze povoleného obsahu → RAG → LLM → odpověď + citované zdroje
 * ```
 *
 * Two authorization checks happen before retrieval, and they are different:
 * conversation *ownership* (your history is not readable through someone else's
 * id — checked in SQL, `WHERE user_id = $actor`) and document *access* (checked
 * inside `ai_search_chunks`, which receives the actor id). Nothing here filters
 * retrieved rows in TypeScript, and nothing here decides access — PLAN §3.1.
 *
 * ## The threshold, and why a follow-up retries retrieval
 *
 * Chunks scoring below `rules.threshold` are dropped before generation. That is
 * what turns "I have nothing" into a real branch rather than a prompt-hint, and
 * it is SPEC §5's "pokud dokumentace odpověď neobsahuje, chatbot to musí přiznat"
 * implemented as something the tests can drive (SPEC.md:133).
 *
 * A follow-up ("a jak dlouho?") carries no vocabulary of its own: it is a
 * pronoun-shaped hole whose subject lives in the previous turn. Retrieving on the
 * bare fragment therefore *should* fail, and the fix is not to loosen the
 * threshold — that would let weak matches through for every question. So when the
 * current question retrieves nothing above threshold and the conversation has an
 * earlier user turn, retrieval is retried on the previous question plus this one,
 * and the answer is marked `contextFromHistory` so the stub can say what it is
 * answering about. The security property is untouched: the retry is still an
 * ACL-filtered search, so widening the *query* never widens the *candidate set*.
 *
 * ## No indirect disclosure
 *
 * The answer and its citations are assembled only from what retrieval returned,
 * and retrieval cannot return what the actor cannot READ. That is the whole
 * mechanism, and it is deliberately boring: there is no "documented but hidden"
 * fallback, no "did you mean", no echo of the question in the non-answer, and no
 * count of how many chunks were excluded. A denial that mentions the thing it is
 * denying is the leak this phase is centrally tested for (PLAN §3.3), so the
 * non-answer is one fixed sentence from the config file, with nothing interpolated
 * into it.
 */

import { Inject, Injectable } from '@nestjs/common';
import { query, withTransaction } from '../db';
import { notFound, validationFailed } from '../http-errors';
import { BehaviorConfigService } from './behavior-config.service';
import type { Citation, GenerationProvider } from './generation.provider';
import type { EmbeddingProvider } from './embedding.provider';
import { EMBEDDING_PROVIDER } from './embedding.provider';
import { RetrievalService, type RetrievedChunk } from './retrieval.service';

export interface AskResult {
  conversationId: string;
  messageId: string;
  answer: string;
  citations: Citation[];
  /** True when the answer stands on an earlier turn rather than this question alone. */
  usedConversationContext: boolean;
  /** True when nothing cleared the threshold, i.e. the bot admitted it does not know. */
  unanswerable: boolean;
  /** Which embedder and generator produced this, so an answer is attributable. */
  provider: { embedding: string; generation: string; behaviorConfig: string };
}

export interface ChatMessage {
  id: string;
  ord: number;
  role: 'user' | 'assistant';
  text: string;
  citations: Citation[];
  createdAt: string;
}

/** How many candidates to pull before thresholding. */
const CANDIDATES = 8;

/**
 * Injection token for `GenerationProvider`.
 *
 * A TypeScript interface erases at compile time, so `constructor(private x:
 * GenerationProvider)` gives Nest nothing to resolve — the token is the only
 * thing that survives to runtime. Bound in `ai.module.ts`, which is the single
 * place that decides *which* provider answers, and therefore the single place to
 * edit when a real model arrives (PLAN §2.1's "one new class" plus one line here,
 * no change to any consumer). The embedding provider's token lives in
 * `embedding.provider.ts` beside the interface it names.
 */
export const GENERATION_PROVIDER = 'kachnadocs:generation-provider';

@Injectable()
export class ChatService {
  constructor(
    private readonly retrieval: RetrievalService,
    @Inject(GENERATION_PROVIDER) private readonly generation: GenerationProvider,
    private readonly behavior: BehaviorConfigService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {}

  /**
   * One question, answered and persisted.
   *
   * The conversation row is created lazily by the first question, which is why
   * `conversationId` is optional: the UI has no id to send before it asks
   * something, and a "create conversation" call would be a second way to make a
   * conversation.
   */
  async ask(actorId: string, question: string, conversationId?: string): Promise<AskResult> {
    const rules = this.behavior.rules();
    const asked = question.trim();
    // Empty question short-circuits before any retrieval: an empty string embeds
    // to the zero vector, which is "says nothing", so it would land below the
    // threshold and produce a *stored* "documentation does not cover that" — a
    // bogus turn in the history that then becomes context for the next question.
    if (!asked) throw validationFailed('question');

    const conversation = await this.ensureConversation(actorId, conversationId, asked);
    const history = await this.messagesOf(conversation.id, actorId);

    let matched = await this.retrieve(actorId, asked);
    let usedConversationContext = false;
    if (matched.length === 0 && history.some((turn) => turn.role === 'user')) {
      const previous = lastUserTurn(history);
      if (previous) {
        const withContext = await this.retrieve(actorId, `${previous} ${asked}`);
        if (withContext.length > 0) {
          matched = withContext;
          usedConversationContext = true;
        }
      }
    }

    const generated = await this.generation.generate({
      question: asked,
      // The threshold decides *whether* to answer; the generator decides how.
      chunks: matched,
      history: history.map((turn) => ({ role: turn.role, text: turn.text })),
      rules,
      contextFromHistory: usedConversationContext,
    });

    const messageId = await this.append(conversation.id, asked, generated.text, generated.citations);
    return {
      conversationId: conversation.id,
      messageId,
      answer: generated.text,
      citations: generated.citations,
      usedConversationContext,
      unanswerable: matched.length === 0,
      provider: {
        embedding: this.embeddings.name,
        generation: this.generation.name,
        behaviorConfig: rules.fingerprint,
      },
    };
  }

  /**
   * Retrieval plus the threshold.
   *
   * Thresholding is per-row and order-independent on purpose: `hnsw.iterative_scan
   * = relaxed_order` (set inside `ai_search_chunks`, because an ACL-filtered
   * top-k scan needs to be allowed to keep draining the index) can hand rows back
   * very slightly out of distance order. A "top N above threshold" cut would
   * depend on that order; a per-row cut cannot.
   */
  private async retrieve(actorId: string, text: string): Promise<RetrievedChunk[]> {
    const rules = this.behavior.rules();
    const candidates = await this.retrieval.search(actorId, text, CANDIDATES);
    return candidates.filter((chunk) => chunk.score >= rules.threshold);
  }

  /** The user's own conversation, or a new one. Someone else's id is a 404, not a 403. */
  private async ensureConversation(
    actorId: string,
    conversationId: string | undefined,
    firstQuestion: string,
  ): Promise<{ id: string }> {
    if (conversationId) {
      const existing = await this.conversationOf(conversationId, actorId);
      if (!existing) throw notFound();
      return { id: existing.id };
    }
    const created = await query<{ id: string }>(
      `INSERT INTO ai_conversations (user_id, title)
       VALUES ($1, $2)
       RETURNING id`,
      [actorId, titleFrom(firstQuestion)],
    );
    const row = created[0];
    if (!row) throw notFound();
    return row;
  }

  /**
   * A conversation's messages, ownership-checked in the same statement.
   *
   * `user_id` is a join predicate rather than a check after the fact: every read
   * path filters in the query (PLAN §3.2), and this one also has to be honest for
   * the messages' *citations*, which name documents. The ownership check is on the
   * conversation, not on each citation — a citation is a record of what this
   * actor's own question retrieved for them at the time, and if their access to a
   * cited document has since been revoked, the honest reading is that a stale
   * citation is a dead link, not a leak: the document id and anchor in it came
   * from content they were permitted to read, and opening it now goes through
   * `can_access_document` like any other request.
   */
  async messagesOf(conversationId: string, actorId: string): Promise<ChatMessage[]> {
    const rows = await query<{
      id: string;
      ord: number;
      role: string;
      text: string;
      citations: Citation[] | string;
      created_at: Date;
    }>(
      `SELECT m.id, m.ord, m.role, m.text, m.citations, m.created_at
         FROM ai_messages m
         JOIN ai_conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1 AND c.user_id = $2
        ORDER BY m.ord`,
      [conversationId, actorId],
    );
    return rows.map((row) => ({
      id: row.id,
      ord: row.ord,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      text: row.text,
      citations:
        typeof row.citations === 'string' ? (JSON.parse(row.citations) as Citation[]) : row.citations,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async conversationsOf(actorId: string): Promise<{ id: string; title: string; updatedAt: string }[]> {
    const rows = await query<{ id: string; title: string; updated_at: Date }>(
      `SELECT c.id, c.title, c.updated_at
         FROM ai_conversations c
        WHERE c.user_id = $1
        ORDER BY c.updated_at DESC
        LIMIT 50`,
      [actorId],
    );
    return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at.toISOString() }));
  }

  /**
   * One conversation by id, for the owner only. Null for "not yours" and for
   * "does not exist" alike, so the caller's 404 cannot be told apart — the rule
   * `notFound()` exists to keep, applied here to conversation ids.
   */
  async conversationOf(
    conversationId: string,
    actorId: string,
  ): Promise<{ id: string; title: string; updatedAt: string } | null> {
    const rows = await query<{ id: string; title: string; updated_at: Date }>(
      'SELECT id, title, updated_at FROM ai_conversations WHERE id = $1 AND user_id = $2',
      [conversationId, actorId],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, title: row.title, updatedAt: row.updated_at.toISOString() };
  }

  /**
   * Append the turn. One statement per message, ord computed under the
   * conversation's row lock so two questions asked at once cannot both pick the
   * same ord and die on the unique index — same shape as publish's version
   * numbering.
   */
  /**
   * Append the turn: the question, then the answer that quotes it.
   *
   * One transaction, with the conversation row locked `FOR UPDATE` first. Without
   * the lock, two questions asked against the same conversation at the same instant
   * both compute the same `max(ord) + 1` and one of them dies on the unique index —
   * and a half-written turn (question stored, answer lost) is the worse failure,
   * because the next question's follow-up retrieval would then build on a question
   * that was never answered. Locking the parent rather than retrying on conflict is
   * the same choice publish makes for version numbers.
   */
  private async append(
    conversationId: string,
    question: string,
    answer: string,
    citations: Citation[],
  ): Promise<string> {
    return withTransaction(async (client) => {
      await client.query('SELECT 1 FROM ai_conversations WHERE id = $1 FOR UPDATE', [conversationId]);
      await client.query(
        `INSERT INTO ai_messages (conversation_id, ord, role, text, citations)
         SELECT $1, coalesce(max(ord), -1) + 1, 'user', $2, '[]'::jsonb FROM ai_messages WHERE conversation_id = $1`,
        [conversationId, question],
      );
      const answerRow = await client.query<{ id: string }>(
        `INSERT INTO ai_messages (conversation_id, ord, role, text, citations)
         SELECT $1, coalesce(max(ord), -1) + 1, 'assistant', $2, $3::jsonb
           FROM ai_messages WHERE conversation_id = $1
          RETURNING id`,
        [conversationId, answer, JSON.stringify(citations)],
      );
      const message = answerRow.rows[0];
      if (!message) throw notFound();
      await client.query('UPDATE ai_conversations SET updated_at = now() WHERE id = $1', [conversationId]);
      return message.id;
    });
  }
}

function lastUserTurn(history: readonly ChatMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn?.role === 'user') return turn.text;
  }
  return null;
}

/** Conversation title: the opening of the first question, hard-capped. */
function titleFrom(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
