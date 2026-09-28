<script setup lang="ts">
import { computed, ref } from 'vue';
import { useCmsStore } from '../stores/cms';
import { useAuthStore } from '../stores/auth';
import EditorSession from './EditorSession.vue';
import { route } from '../editor/deepLink';

/**
 * The editor view's registration point (SPEC.md §2).
 *
 * Deliberately thin: it decides *whether* there is a document to edit and hands the
 * rest to `EditorSession`, which is keyed on the document id so that switching
 * documents unmounts the previous session entirely.
 *
 * The key is the important part, and it is not a shortcut. A session owns a Tiptap
 * editor, a Y.Doc, an Awareness, a websocket provider, a ticket-rotation timer and a
 * reference cache — six things whose cleanup order matters and any one of which,
 * left alive after a document switch, produces a bug that looks like a different
 * bug: the old provider keeps publishing presence into the previous document's room,
 * or the old Y.Doc's content renders inside the new document's editor. Re-rendering
 * a component with a new key makes Vue run every `onScopeDispose` before the next
 * session's setup, which is the ordering that keeps those six from crossing over —
 * and it is one line instead of a watcher that forgets one of them.
 */
const cms = useCmsStore();
const auth = useAuthStore();

/**
 * Bumped to rebuild a session from scratch.
 *
 * The document id is only half of a session's identity: when a *reader* has a document
 * open and somebody publishes, the content on screen is a snapshot of a version that
 * no longer exists, and it cannot be updated in place — their Y.Doc holds the previous
 * version's items permanently, so serving the new one merges and shows both. What is
 * needed is a session with a brand-new Y.Doc, which is what a changed `:key` produces.
 *
 * Combined with the id rather than replacing it, so a document switch still rebuilds
 * (the original reason for the key) and a republish rebuilds too.
 */
const sessionNonce = ref(0);

// A deep link opens a document that the tree may not have selected yet, so the URL
// is consulted before the selection: `/d/<id>` arrives on first paint, `cms.load()`
// later, and reading only `selectedId` would show the empty state for a moment that
// a reader who clicked a link in chat would call a broken link.
const documentId = computed(() => route.value.documentId ?? cms.selectedId);

const document = computed(() => cms.documents.find((d) => d.id === documentId.value) ?? null);

const me = computed(() => (auth.user ? { id: auth.user.id, displayName: auth.user.displayName } : null));

function onRepublished(): void {
  // The tree's idea of the version list is stale too, and this is the one place that
  // knows a publish just happened; without it the reader's history panel would still
  // name the old head after their document has been replaced with the new one.
  void cms.load();
  sessionNonce.value += 1;
}
</script>

<template>
  <div class="editor-panel">
    <p v-if="!documentId" class="muted hint">
      Vyberte dokument v stromu dokumentace — nebo otevřete přímý odkaz na oddíl.
    </p>
    <EditorSession
      v-else
      :key="`${documentId}:${sessionNonce}`"
      :document-id="documentId"
      :title="document?.title ?? null"
      :me="me"
      @republished="onRepublished"
    />
  </div>
</template>

<style scoped>
.editor-panel {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.hint {
  padding: 0.75rem 0.6rem;
  font-size: 0.85rem;
}
</style>
