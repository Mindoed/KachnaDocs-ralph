<script setup lang="ts">
import { computed } from 'vue';
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

// A deep link opens a document that the tree may not have selected yet, so the URL
// is consulted before the selection: `/d/<id>` arrives on first paint, `cms.load()`
// later, and reading only `selectedId` would show the empty state for a moment that
// a reader who clicked a link in chat would call a broken link.
const documentId = computed(() => route.value.documentId ?? cms.selectedId);

const document = computed(() => cms.documents.find((d) => d.id === documentId.value) ?? null);

const me = computed(() => (auth.user ? { id: auth.user.id, displayName: auth.user.displayName } : null));
</script>

<template>
  <div class="editor-panel">
    <p v-if="!documentId" class="muted hint">
      Vyberte dokument v stromu dokumentace — nebo otevřete přímý odkaz na oddíl.
    </p>
    <EditorSession
      v-else
      :key="documentId"
      :document-id="documentId"
      :title="document?.title ?? null"
      :me="me"
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
