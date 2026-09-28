<script setup lang="ts">
import { Editor } from '@tiptap/core';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { RealtimeStatusDto } from '@kachnadocs/shared';
import { api } from '../api';
import { useCmsStore } from '../stores/cms';
import { editorExtensions } from '../editor/extensions';
import { beginEditor, endEditor, type ReferenceResolver } from '../editor/references';
import { useRealtime, type EditorIdentity } from '../editor/useRealtime';
import { route, scrollToAnchor } from '../editor/deepLink';

/**
 * One editing session for one document (SPEC.md §2).
 *
 * ## Why the save indicator is polled and not inferred
 *
 * `Ukládání… / Uloženo` comes from `GET /documents/:id/realtime-status`, which
 * reports the gateway's own "is this room behind the database" flag. The tempting
 * implementation — show "Ukládání…" for a second after a keystroke, then "Uloženo" —
 * makes a claim about a database row out of local optimism, and it is wrong in the
 * one case that matters: the server's projection throws, the write never happens, and
 * the UI has already promised it did. Polling every two seconds is unglamorous and
 * honest; the interval is not tuned, it just sits well past the server's 400 ms
 * debounce and costs a small read.
 *
 * ## What read-only means here
 *
 * `editable` follows the *ticket*, not a guess from the user's role list. The ticket
 * is the server's answer to "what may this connection do", computed by the same SQL
 * every HTTP route uses, so the toolbar and the socket cannot disagree — and if the
 * toolbar were somehow wrong, the socket still closes on the first update frame, which
 * is the part SPEC.md §3 counts as security.
 *
 * ## Lifecycle
 *
 * The editor is built once the ticket has arrived, because `canEdit` selects the
 * extension set (a reader must not generate heading anchors merely by looking at a
 * document), and mounted onto the host div as it is created — Tiptap 3 accepts an
 * `element` option and mounts in the constructor, which removes the
 * "constructed-then-mounted" window in which a view can end up bound to a detached
 * node: a document that renders correctly and ignores every keystroke.
 */
const props = defineProps<{ documentId: string; title: string | null; me: EditorIdentity | null }>();

const cms = useCmsStore();
const host = ref<HTMLElement | null>(null);
const editor = shallowRef<Editor | null>(null);
const preview = ref(false);
const saved = ref(true);
const saveError = ref<string | null>(null);
const notice = ref<string | null>(null);
const linkForm = ref({ open: false, document: '', anchor: '' });
/**
 * An image is inserted by URL, from a field, rather than by a `prompt()` dialog or a
 * file picker. There is no upload endpoint yet — SPEC.md §2 asks for images in the
 * document model, not for file storage, and inventing a POST /uploads here would be
 * an unauthenticated-by-default place to put arbitrary bytes. The URL form is what
 * the node actually stores.
 */
const imageForm = ref({ open: false, src: '' });

const realtime = useRealtime(
  computed(() => props.documentId),
  computed(() => props.me),
);

/**
 * Unwrapped in the template by being top-level bindings.
 *
 * Vue unwraps refs it finds at the top level of a setup() result and nothing deeper:
 * `realtime.peers` inside the template would be a ComputedRef object rendered as
 * `[object Object]`, and `v-for` over it would fail in a way that reads like a data
 * bug rather than a binding one. Two aliases here are cheaper than `unref` at each of
 * four call sites and impossible to forget.
 */
const peers = realtime.peers;
const status = realtime.status;

let resolver: ReferenceResolver | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const canEdit = computed(() => realtime.permission.value === 'WRITE');
const editing = computed(() => canEdit.value && !preview.value);

const saveLabel = computed(() => {
  if (!canEdit.value) return realtime.permission.value === 'READ' ? 'Režim jen pro čtení' : 'Připojuji…';
  return saved.value ? 'Uloženo' : 'Ukládám…';
});

/**
 * Build the editor against the live Y.Doc.
 *
 * Rebuilt whenever the ticket changes rather than only on mount: a rotation that
 * comes back `READ` for someone whose WRITE was revoked must produce a different
 * extension set (no anchor generation) and a non-editable view, and patching a live
 * editor down to that is more states to get wrong than making a new one.
 */
function createEditor(): void {
  destroyEditor();
  if (!host.value) return;
  resolver = beginEditor();
  editor.value = new Editor({
    element: host.value,
    extensions: editorExtensions({
      ydoc: realtime.ydoc,
      awareness: realtime.awareness,
      canEdit: canEdit.value,
    }),
    editable: editing.value,
  });
}

function destroyEditor(): void {
  editor.value?.destroy();
  editor.value = null;
  if (resolver) {
    endEditor(resolver);
    resolver = null;
  }
}

async function pollStatus(): Promise<void> {
  try {
    const status = await api<RealtimeStatusDto>(`/documents/${props.documentId}/realtime-status`);
    saved.value = status.saved;
    saveError.value = null;
  } catch {
    // A failed poll says nothing about the draft, so it must not flip the label to
    // "Ukládání…" — that would assert unsaved changes on the strength of a network
    // error. The last known answer stays on screen and the failure is named separately.
    saveError.value = 'Stav uložení se nepodařilo ověřit.';
  }
}

function togglePreview(): void {
  preview.value = !preview.value;
  editor.value?.setEditable(editing.value);
}

/**
 * Copy a link to the heading the caret is in (SPEC.md §2, "kopírování odkazu na
 * konkrétní část dokumentu").
 *
 * Walks *up* from the selection rather than only inspecting its parent node, because
 * a caret is nearly always inside the paragraph under a heading and not inside the
 * heading itself — parent-only would answer "no heading here" for almost every real
 * cursor position. If the caret is above the first heading, the nearest heading
 * before it is used, which is the section a reader would say they are looking at.
 */
async function copyHeadingLink(): Promise<void> {
  const instance = editor.value;
  if (!instance) return;
  const { $from } = instance.state.selection;

  let anchor: string | null = null;
  for (let depth = $from.depth; depth >= 0 && anchor === null; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'heading' && typeof node.attrs['anchor'] === 'string') {
      anchor = node.attrs['anchor'];
    }
  }
  if (anchor === null) {
    instance.state.doc.descendants((node, pos) => {
      if (anchor !== null || pos >= $from.pos) return anchor !== null;
      if (node.type.name === 'heading' && typeof node.attrs['anchor'] === 'string') {
        anchor = node.attrs['anchor'];
      }
      return true;
    });
  }
  if (anchor === null) {
    notice.value = 'Nadpis nad tímto místem ještě není — odkaz se vztahuje na nadpis.';
    return;
  }

  const url = `${window.location.origin}/d/${encodeURIComponent(props.documentId)}#${encodeURIComponent(anchor)}`;
  try {
    await navigator.clipboard.writeText(url);
    notice.value = `Odkaz zkopírován: #${anchor}`;
  } catch {
    // Clipboard access needs focus and permission. A denial must not lose the URL, so
    // it goes in the notice where it can be selected by hand.
    notice.value = `Odkaz: ${url}`;
  }
}

/**
 * Ask for a link target rather than typing a URL.
 *
 * Slug *or* id is offered because the resolve endpoint accepts both and a document
 * list is one panel away anyway; the placeholder says which is expected so a typo
 * becomes a visible "načítám" rather than a silent wrong-document.
 */
function insertReference(): void {
  const instance = editor.value;
  const target = linkForm.value.document.trim();
  if (!instance || !target) return;
  instance
    .chain()
    .focus()
    .insertContent({
      type: 'docReference',
      attrs: { document: target, anchor: linkForm.value.anchor.trim() || null },
    })
    .run();
  linkForm.value = { open: false, document: '', anchor: '' };
}

/** The node stores the URL it was given; nothing fetches or validates it here. */
function insertImage(): void {
  const instance = editor.value;
  const src = imageForm.value.src.trim();
  if (!instance || !src) return;
  instance.chain().focus().setImage({ src }).run();
  imageForm.value = { open: false, src: '' };
}

/**
 * Publish the draft this editor is live on.
 *
 * The gateway flushes before snapshotting (`flushNow`), so what lands in the version
 * is the document as it stands right now rather than as of the last debounce window —
 * the reason that flush exists is exactly this button being clicked mid-sentence.
 */
async function publish(): Promise<void> {
  await cms.publish('');
}

function followAnchor(): void {
  if (route.value.documentId === props.documentId) void scrollToAnchor(route.value.anchor);
}

onMounted(() => {
  // Keep the tree and the version panel naming the same document. `select` is a no-op
  // when already selected, so the ordinary case costs nothing.
  void cms.select(props.documentId);
  createEditor();
  followAnchor();
  void pollStatus();
  pollTimer = setInterval(() => void pollStatus(), 2000);
  window.addEventListener('hashchange', followAnchor);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  window.removeEventListener('hashchange', followAnchor);
  destroyEditor();
});

watch(canEdit, createEditor);
</script>

<template>
  <div class="session">
    <header class="bar">
      <strong class="doc-title">{{ title ?? 'Dokument' }}</strong>
      <span class="presence" data-testid="presence">
        <span v-for="peer in peers" :key="peer.id" class="chip" :style="{ '--chip': peer.color }">
          {{ peer.displayName }}
        </span>
        <span v-if="peers.length === 0" class="muted">nikdo další</span>
      </span>
      <span class="spacer" />
      <span class="save" :class="{ pending: !saved && canEdit }" data-testid="save-state">{{
        saveLabel
      }}</span>
    </header>

    <div v-if="canEdit" class="toolbar">
      <button type="button" @click="editor?.chain().focus().toggleBold().run()">Tučně</button>
      <button type="button" @click="editor?.chain().focus().toggleItalic().run()">Kurzíva</button>
      <button type="button" @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()">Nadpis</button>
      <button type="button" @click="editor?.chain().focus().toggleBulletList().run()">Seznam</button>
      <button type="button" @click="editor?.chain().focus().toggleTaskList().run()">Checklist</button>
      <button type="button" @click="editor?.chain().focus().toggleCodeBlock().run()">Kód</button>
      <button
        type="button"
        @click="editor?.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()"
      >
        Tabulka
      </button>
      <!-- Link wraps the current selection; with nothing selected it does nothing,
           which is the honest behaviour. `setLink` over a hand-typed href would be
           the other option and is left to the phase-5 slash menu. -->
      <button type="button" @click="editor?.chain().focus().toggleLink({ href: '' }).run()">Odkaz</button>
      <button
        type="button"
        @click="
          linkForm.open = false;
          imageForm.open = !imageForm.open;
        "
      >
        Obrázek
      </button>
      <button type="button" data-testid="insert-reference" @click="linkForm.open = !linkForm.open">
        Odkaz na oddíl
      </button>
      <button type="button" data-testid="copy-heading-link" @click="copyHeadingLink">
        Kopírovat odkaz na oddíl
      </button>
      <button type="button" data-testid="publish" :disabled="cms.busy" @click="publish">Publikovat</button>
    </div>

    <form v-if="imageForm.open" class="link-form" @submit.prevent="insertImage">
      <input v-model="imageForm.src" placeholder="URL obrázku" aria-label="URL obrázku" />
      <button type="submit">Vložit obrázek</button>
    </form>

    <form v-if="linkForm.open" class="link-form" @submit.prevent="insertReference">
      <input v-model="linkForm.document" placeholder="cíl — slug nebo id" aria-label="Cílový dokument" />
      <input v-model="linkForm.anchor" placeholder="oddíl (volitelné)" aria-label="Cílový oddíl" />
      <button type="submit">Vložit</button>
    </form>

    <div class="modes">
      <button type="button" data-testid="toggle-preview" :disabled="!canEdit" @click="togglePreview">
        {{ preview ? 'Upravit' : 'Náhled' }}
      </button>
      <span class="muted mode-hint">
        {{
          canEdit
            ? 'Editor pracuje s konceptem — publikované verze se nedotkne.'
            : 'Čtete publikovanou verzi.'
        }}
      </span>
    </div>

    <div ref="host" class="surface" :class="{ readonly: !editing }" data-testid="editor-host" />

    <p v-if="notice" class="notice" data-testid="notice">{{ notice }}</p>
    <p v-if="saveError" class="error" data-testid="save-error">{{ saveError }}</p>
    <p v-if="status === 'error'" class="error">
      Nepodařilo se navázat spojení s editorem.
      <button type="button" @click="realtime.reconnect()">Zkusit znovu</button>
    </p>
  </div>
</template>

<style scoped>
.session {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
}

.doc-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.presence {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.chip {
  border: 1px solid var(--chip);
  border-radius: 999px;
  padding: 0 0.45rem;
  font-size: 0.75rem;
  color: var(--fg-dim);
}

.spacer {
  flex: 1;
}

.save {
  color: var(--fg-dim);
  white-space: nowrap;
}

.save.pending {
  color: var(--accent);
}

.toolbar,
.modes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  padding: 0.4rem 0.6rem;
  align-items: center;
}

.toolbar button,
.modes button,
.link-form button {
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0.15rem 0.5rem;
  font-size: 0.8rem;
  background: var(--bg-raised);
  color: var(--fg);
}

.toolbar button:hover,
.modes button:hover {
  background: var(--bg-hover);
}

.mode-hint {
  font-size: 0.75rem;
}

.link-form {
  display: flex;
  gap: 0.3rem;
  padding: 0 0.6rem 0.4rem;
}

.link-form input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0.2rem 0.4rem;
  background: var(--bg);
  color: var(--fg);
}

.surface {
  flex: 1;
  padding: 0.75rem 0.9rem 3rem;
  outline: none;
  line-height: 1.55;
}

.surface.readonly :deep(.tiptap) {
  color: var(--fg-dim);
}

.notice,
.error {
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
}

.error {
  color: var(--danger);
}
</style>

<style>
/* Not scoped: the caret and the reference label are rendered by ProseMirror and by
   the NodeView, outside this component's subtree, where a scoped attribute is never
   applied. They are namespaced by class rather than by element. */
.remote-caret {
  border-left: 2px solid var(--caret);
  position: relative;
  margin: 0 -1px;
}

.remote-caret-label {
  position: absolute;
  bottom: 100%;
  left: -1px;
  background: var(--caret);
  color: #fff;
  font-size: 0.65rem;
  line-height: 1.2;
  padding: 0 0.25rem;
  border-radius: 3px 3px 3px 0;
  white-space: nowrap;
}

.doc-ref {
  border-bottom: 1px dotted var(--fg-dim);
  cursor: help;
}

.doc-ref[data-resolved='loading'] {
  color: var(--fg-dim);
}

.doc-ref[data-resolved='inaccessible'] {
  color: var(--fg-dim);
  font-style: italic;
}
</style>
