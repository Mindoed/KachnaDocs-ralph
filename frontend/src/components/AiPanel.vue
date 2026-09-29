<script setup lang="ts">
import type { AiAnswerDto, AiCitationDto, AiConversationDto } from '@kachnadocs/shared';
import { nextTick, onMounted, ref } from 'vue';
import { api, ApiError } from '../api';
import { openDocument } from '../editor/deepLink';

/**
 * The AI chat (SPEC §5): ask a question, read the answer, click a citation.
 *
 * Everything on this screen is a *display* of decisions the backend already made.
 * The retrieval that chose these chunks was ACL-filtered in SQL, and the answer's
 * wording came from the server; nothing here filters, hides, or vetoes anything,
 * and SPEC §3 says plainly that hiding a control is not a security measure. So the
 * one genuinely security-relevant thing this file does is *link*: a citation chip
 * navigates, and whether that navigation shows a document is decided by the
 * document view's own permission check, not by whether the chip was rendered.
 *
 * Which is also why a chip is rendered for every citation the server returned.
 * Suppressing one client-side would mean this file had an opinion about access —
 * an opinion with no access to the one thing that decides, `can_access_document`.
 *
 * Conversation history is the server's, not ours: `POST /ai/ask` appends both turns
 * to `ai_messages` and `GET /ai/conversations/:id` reads them back, so a reload
 * restores the exchange and the "follow-up questions" behaviour is a property of
 * the stored conversation rather than of this component's lifetime.
 */

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  citations: AiCitationDto[];
  /** Kept so an answer can say it rested on an earlier turn. */
  usedConversationContext?: boolean;
  unanswerable?: boolean;
}

/**
 * Which conversation this browser was last looking at.
 *
 * The turns themselves are the server's (`ai_messages`), so a reload *can* restore
 * them — but only if the panel asks for one. Restoring the panel to an empty thread
 * while the history sits one click away would make "persisted message history" true
 * of the database and false of the product, so the id of the open conversation is
 * remembered.
 *
 * Only the id, never a turn: the content belongs to the server, and a second copy in
 * localStorage would be a second truth free to disagree with the first.
 */
const CONVERSATION_KEY = 'kachnadocs.ai.conversation';

function rememberedConversation(): string | null {
  try {
    return localStorage.getItem(CONVERSATION_KEY);
  } catch {
    return null;
  }
}

function rememberConversation(id: string | null): void {
  try {
    if (id) localStorage.setItem(CONVERSATION_KEY, id);
    else localStorage.removeItem(CONVERSATION_KEY);
  } catch {
    // Private mode / quota: the panel simply opens on a fresh thread next time.
  }
}

const turns = ref<Turn[]>([]);
const conversations = ref<AiConversationDto[]>([]);
const conversationId = ref<string | null>(null);
const question = ref('');
const asking = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const list = ref<HTMLElement | null>(null);

async function scrollToEnd(): Promise<void> {
  await nextTick();
  list.value?.scrollTo({ top: list.value.scrollHeight });
}

async function loadConversations(): Promise<void> {
  try {
    conversations.value = await api<AiConversationDto[]>('/ai/conversations');
  } catch (err) {
    error.value = describe(err);
  }
}

async function open(id: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const detail = await api<{
      messages: { role: 'user' | 'assistant'; text: string; citations: AiCitationDto[] }[];
    }>(`/ai/conversations/${encodeURIComponent(id)}`);
    conversationId.value = id;
    rememberConversation(id);
    turns.value = detail.messages.map((m) => ({ role: m.role, text: m.text, citations: m.citations ?? [] }));
    await scrollToEnd();
  } catch (err) {
    // Someone else's conversation and a nonexistent one are the same 404 with the
    // same body, on purpose (PLAN §3). This message therefore cannot and does not
    // say which it was — nor may it grow a "but this one exists" branch later.
    error.value = describe(err);
    turns.value = [];
  } finally {
    loading.value = false;
  }
}

function start(): void {
  conversationId.value = null;
  rememberConversation(null);
  turns.value = [];
  error.value = null;
  question.value = '';
}

async function ask(): Promise<void> {
  const text = question.value.trim();
  if (!text || asking.value) return;
  asking.value = true;
  error.value = null;
  // The question appears on screen the moment it is sent, before the answer — but
  // the stored turn is the server's, written in the same transaction as the answer.
  turns.value = [...turns.value, { role: 'user', text, citations: [] }];
  question.value = '';
  await scrollToEnd();
  try {
    const answer = await api<AiAnswerDto>('/ai/ask', {
      method: 'POST',
      body: JSON.stringify({ question: text, conversationId: conversationId.value ?? undefined }),
    });
    conversationId.value = answer.conversationId;
    rememberConversation(answer.conversationId);
    turns.value = [
      ...turns.value,
      {
        role: 'assistant',
        text: answer.answer,
        citations: answer.citations,
        usedConversationContext: answer.usedConversationContext,
        unanswerable: answer.unanswerable,
      },
    ];
    await loadConversations();
    await scrollToEnd();
  } catch (err) {
    error.value = describe(err);
    // The optimistic question has no answer to be part of; drop it rather than
    // leave a question on screen that the history will not contain after a reload.
    turns.value = turns.value.filter((t, i) => i < turns.value.length - 1);
    question.value = text;
  } finally {
    asking.value = false;
  }
}

/**
 * A citation chip navigates to `/d/<document>#<anchor>`, which is the same deep-link
 * form the editor writes when copying a heading link — so a citation and a copied
 * link are the same artifact and resolve through the same one path.
 *
 * `anchor: null` is not a defect. A chunk before the first heading cites the
 * document, which SPEC §5 allows explicitly; the chip then links to the document.
 */
function openCitation(citation: AiCitationDto): void {
  openDocument(citation.documentId, citation.anchor, true);
}

function describe(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Požadavek se nepodařilo dokončit.';
}

/**
 * The conversation count as Czech prose.
 *
 * `{{ n }} konverzací` reads correctly for 5 and wrong for 2, and this label sits
 * beside a list that is usually two or three entries long — so the wrong form is the
 * common case, not the edge one. An assistant that misinflects its own chrome is a
 * poor thing to also trust with Czech prose.
 */
function conversationCount(count: number): string {
  const noun = count >= 2 && count <= 4 ? 'konverzace' : 'konverzací';
  return `${count} ${noun}`;
}

onMounted(async () => {
  await loadConversations();
  // Restore the thread this browser was last reading, so a reload returns to the
  // conversation rather than to an empty box with the history hidden behind a
  // disclosure triangle.
  //
  // Gated on the id being in the list we just fetched, rather than opened blindly:
  // a remembered id can be stale (a conversation deleted elsewhere, a different
  // user on this browser profile), and restoring it would then surface a 404 as the
  // panel's *first* render — an error the user did nothing to earn. Absent from the
  // list is treated as "nothing to restore", which is also what it means.
  const remembered = rememberedConversation();
  if (remembered && conversations.value.some((c) => c.id === remembered)) await open(remembered);
  else if (remembered) rememberConversation(null);
});
</script>

<template>
  <div class="chat">
    <div class="toolbar">
      <button data-testid="ai-new" @click="start">Nová konverzace</button>
      <span v-if="conversations.length > 1" class="muted count">
        {{ conversationCount(conversations.length) }}
      </span>
    </div>

    <details v-if="conversations.length > 0" class="history">
      <summary>Předchozí konverzace</summary>
      <ul>
        <li v-for="c in conversations" :key="c.id">
          <button class="link" :class="{ current: c.id === conversationId }" @click="open(c.id)">
            {{ c.title || '(bez názvu)' }}
          </button>
        </li>
      </ul>
    </details>

    <div ref="list" class="messages" data-testid="ai-messages">
      <p v-if="loading" class="muted">Načítám…</p>
      <p v-else-if="turns.length === 0" class="muted empty">
        Zeptejte se na něco z publikované dokumentace. Odpověď vychází pouze z dokumentů, ke kterým máte
        přístup — a cituje je.
      </p>

      <article
        v-for="(turn, index) in turns"
        :key="index"
        class="turn"
        :data-role="turn.role"
        :data-unanswerable="turn.unanswerable ? 'true' : null"
      >
        <p class="text">{{ turn.text }}</p>

        <p v-if="turn.usedConversationContext" class="context-note muted">navazuje na předchozí dotaz</p>

        <ul v-if="turn.citations.length > 0" class="citations">
          <li v-for="(c, ci) in turn.citations" :key="`${c.documentId}-${c.versionNumber}-${ci}`">
            <button
              class="chip"
              data-testid="ai-citation"
              :title="`Skóre shody ${c.score.toFixed(2)} — ${c.heading}`"
              @click="openCitation(c)"
            >
              <span class="chip-title">{{ c.documentTitle }}</span>
              <span v-if="c.anchor" class="chip-anchor">#{{ c.anchor }}</span>
              <span class="chip-score muted">{{ c.score.toFixed(2) }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="turn.role === 'assistant'" class="muted no-sources">bez zdrojů</p>
      </article>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <form class="composer" @submit.prevent="ask">
      <input
        v-model="question"
        data-testid="ai-input"
        type="text"
        placeholder="Zeptejte se na dokumentaci…"
        :disabled="asking"
      />
      <button type="submit" data-testid="ai-ask" :disabled="asking || question.trim().length === 0">
        {{ asking ? 'Odpovídám…' : 'Zeptat' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.chat {
  padding: 0.5rem 0.6rem;
  display: grid;
  grid-template-rows: auto auto 1fr auto auto;
  gap: 0.5rem;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.toolbar button,
.composer button {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.2rem 0.5rem;
  font-size: 0.8rem;
  color: var(--fg-dim);
}

.toolbar button:hover,
.composer button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--fg);
}

.count {
  font-size: 0.75rem;
}

.history summary {
  font-size: 0.75rem;
  color: var(--fg-dim);
  cursor: pointer;
}

.history ul {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.15rem;
  max-height: 8rem;
  overflow-y: auto;
}

.link {
  border: 0;
  background: none;
  padding: 0.1rem 0;
  font-size: 0.8rem;
  color: var(--fg-dim);
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.link:hover {
  color: var(--accent);
}

.link.current {
  color: var(--fg);
}

.messages {
  display: grid;
  gap: 0.45rem;
  align-content: start;
  overflow-y: auto;
  min-height: 6rem;
}

.empty {
  font-size: 0.85rem;
}

.turn {
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0.4rem 0.45rem;
  display: grid;
  gap: 0.3rem;
}

.turn[data-role='user'] {
  background: var(--bg-hover);
}

.turn[data-unanswerable='true'] {
  border-style: dashed;
}

.text {
  margin: 0;
  font-size: 0.85rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.context-note {
  font-size: 0.72rem;
  margin: 0;
}

.citations {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.1rem 0.45rem;
  background: none;
  font-size: 0.72rem;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.chip-anchor {
  font-family: var(--mono);
  color: var(--fg-dim);
}

.chip-score {
  font-family: var(--mono);
  font-size: 0.68rem;
}

.no-sources {
  font-size: 0.72rem;
  margin: 0;
}

.composer {
  display: flex;
  gap: 0.35rem;
}

.composer input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.25rem 0.4rem;
  font-size: 0.85rem;
  background: var(--bg);
  color: var(--fg);
}
</style>
