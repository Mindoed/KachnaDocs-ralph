<script setup lang="ts">
import { DOCUMENT_STATE_LABEL } from '@kachnadocs/shared';
import { computed, nextTick, onMounted, ref } from 'vue';
import { useCmsStore, type TreeNode } from '../stores/cms';

/**
 * The documentation tree (SPEC.md §1): groups, categories, documents, with
 * keyboard selection and context actions.
 *
 * Keyboard model is the one the SPEC asks for ("keyboard-friendly selection"):
 * ↑/↓ walk the flattened tree, Enter opens, F2 renames, Delete archives. The
 * list is a roving-tabindex listbox rather than N tab stops, so Tab leaves the
 * tree for the rest of the workbench instead of requiring 200 presses.
 */
const cms = useCmsStore();

const activeDescendant = ref<string | null>(null);
const listRef = ref<HTMLElement | null>(null);
const editingId = ref<string | null>(null);
const draftTitle = ref('');
const newTitle = ref('');
const newGroupId = ref('');

/** Which document has its move form open, plus the form's own pending values. */
const moving = ref<string | null>(null);
const moveGroup = ref('');
const moveCategory = ref<string | null>(null);

const rows = computed(() => cms.tree);

onMounted(async () => {
  await cms.ensureLoaded();
  newGroupId.value = cms.writableGroups[0]?.id ?? '';
  if (rows.value[0]) activeDescendant.value = rows.value[0].key;
});

function focusKey(key: string): void {
  activeDescendant.value = key;
  void nextTick(() => {
    listRef.value?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
  });
}

function move(delta: number): void {
  const list = rows.value;
  if (list.length === 0) return;
  const at = list.findIndex((r) => r.key === activeDescendant.value);
  const next = Math.min(list.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta));
  const row = list[next];
  if (row) focusKey(row.key);
}

/** Clicking or tabbing onto a row makes it the active one, so arrows continue from there. */
function onRowFocus(key: string): void {
  activeDescendant.value = key;
}

function onKeydown(event: KeyboardEvent): void {
  const key = activeDescendant.value;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    if (rows.value[0]) focusKey(rows.value[0].key);
  } else if (event.key === 'End') {
    event.preventDefault();
    const last = rows.value[rows.value.length - 1];
    if (last) focusKey(last.key);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const row = rows.value.find((r) => r.key === key);
    if (row?.kind === 'document') void cms.select(row.id);
  } else if (event.key === 'F2') {
    const row = rows.value.find((r) => r.key === key);
    if (row?.kind === 'document' && cms.can(row.id, 'WRITE')) startRename(row.id);
  } else if (event.key === 'Delete') {
    const row = rows.value.find((r) => r.key === key);
    // Delete archives rather than destroys. Permanent removal stays a click on
    // the explicit button, which also asks first — a stray keypress should not
    // delete published history, which is what deleting a document does.
    if (row?.kind === 'document' && cms.can(row.id, 'WRITE')) void cms.setState(row.id, 'Archived');
  }
}

function startRename(id: string): void {
  editingId.value = id;
  draftTitle.value = cms.documents.find((d) => d.id === id)?.title ?? '';
}

async function commitRename(): Promise<void> {
  if (editingId.value === null) return;
  const id = editingId.value;
  editingId.value = null;
  const title = draftTitle.value.trim();
  const before = cms.documents.find((d) => d.id === id)?.title;
  if (title && title !== before) await cms.rename(id, title);
}

async function createDocument(): Promise<void> {
  const title = newTitle.value.trim();
  if (!title || !newGroupId.value) return;
  if (await cms.create(title, newGroupId.value)) newTitle.value = '';
}

/**
 * Handlers take the whole row rather than `row.document.id`. The alternative —
 * inlining `row.document.id` in the template — compiles only because the guard
 * and the expression sit in the same v-if scope, and vue-tsc does not narrow
 * across the element boundary in the nested button; a function here keeps the
 * check in TypeScript where a mistake is a build error.
 */
function toggleArchive(row: TreeNode): void {
  const doc = row.document;
  if (!doc) return;
  void cms.setState(doc.id, doc.state === 'Archived' ? 'Draft' : 'Archived');
}

function remove(row: TreeNode): void {
  const doc = row.document;
  if (!doc) return;
  // Deleting destroys the published history too (versions cascade), so it asks.
  if (window.confirm(`Smazat „${doc.title}“ včetně publikované historie?`)) void cms.remove(doc.id);
}

/**
 * Move is opened per-row and preselects where the document already is, so the
 * common case is "change one select, confirm" rather than re-entering the whole
 * location. Only writable groups are offered: the API requires WRITE on the
 * destination group, and offering a group that will refuse is a worse answer
 * than not offering it.
 */
function startMove(row: TreeNode): void {
  const doc = row.document;
  if (!doc) return;
  moving.value = doc.id;
  moveGroup.value = doc.groupId;
  moveCategory.value = doc.categoryId;
}

async function commitMove(): Promise<void> {
  const id = moving.value;
  if (!id || !moveGroup.value) return;
  moving.value = null;
  await cms.move(id, moveGroup.value, moveCategory.value);
}
</script>

<template>
  <div class="cms">
    <p v-if="cms.error" class="error message">{{ cms.error }}</p>
    <p v-else-if="cms.notice" class="notice message">{{ cms.notice }}</p>

    <form v-if="cms.writableGroups.length > 0" class="create" @submit.prevent="createDocument">
      <input v-model="newTitle" placeholder="Nový dokument…" aria-label="Název nového dokumentu" />
      <select v-model="newGroupId" aria-label="Skupina">
        <option v-for="g in cms.writableGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
      </select>
      <button type="submit" :disabled="cms.busy || !newTitle.trim()">Vytvořit</button>
    </form>

    <p v-if="cms.loading && rows.length === 0" class="muted message">Načítám…</p>

    <!--
      Roving tabindex: exactly one row is tabbable at a time and the rest are
      -1, so Tab steps out of the tree in one press. The container itself is not
      focusable — a focusable container plus focusable children gives two tab
      stops for the same widget.
    -->
    <div v-else ref="listRef" class="tree" role="tree" aria-label="Dokumentace" @keydown="onKeydown">
      <p v-if="rows.length === 0" class="muted message">Žádné dokumenty.</p>
      <template v-for="row in rows" :key="row.key">
        <div
          :id="row.key"
          :data-key="row.key"
          class="row"
          :class="[row.kind, { selected: row.document?.id === cms.selectedId }]"
          :style="{ '--depth': row.depth }"
          :role="row.kind === 'document' ? 'treeitem' : 'group'"
          :aria-level="row.depth + 1"
          :aria-selected="row.document?.id === cms.selectedId"
          :tabindex="row.key === activeDescendant ? 0 : -1"
          @click="row.kind === 'document' && cms.select(row.id)"
          @focus="onRowFocus(row.key)"
        >
          <span class="icon muted">{{
            row.kind === 'group' ? '▸' : row.kind === 'category' ? '◇' : '·'
          }}</span>

          <input
            v-if="editingId === row.id"
            v-model="draftTitle"
            class="rename"
            aria-label="Nový název"
            @blur="commitRename"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="editingId = null"
            @click.stop
          />
          <span v-else class="label">{{ row.label }}</span>

          <span v-if="row.document" class="badge" :data-state="row.document.state">
            {{ DOCUMENT_STATE_LABEL[row.document.state] }}
          </span>
          <span v-else-if="row.documentCount !== undefined" class="count muted">{{ row.documentCount }}</span>

          <span v-if="row.document && cms.can(row.document.id, 'WRITE')" class="actions">
            <button class="act" title="Přejmenovat (F2)" @click.stop="startRename(row.document.id)">✎</button>
            <button class="act" title="Přesunout" @click.stop="startMove(row)">⇄</button>
            <button
              class="act"
              :title="row.document.state === 'Archived' ? 'Obnovit' : 'Archivovat (Delete)'"
              @click.stop="toggleArchive(row)"
            >
              {{ row.document.state === 'Archived' ? '↩' : '⤓' }}
            </button>
          </span>
          <span v-if="row.document && cms.can(row.document.id, 'MANAGE')" class="actions">
            <button class="act danger" title="Smazat navždy i s historií" @click.stop="remove(row)">✕</button>
          </span>
        </div>

        <!--
        Move appears as its own line under the document rather than inside the
        row: two selects need more width than a tree row offers. It renders only
        beneath the row it was opened from. The category list follows the chosen
        group, because the API rejects a document whose category belongs to a
        different group.
      -->
        <div
          v-if="moving === row.id"
          role="presentation"
          class="move"
          :style="{ '--depth': row.depth + 1 }"
          @keydown.esc.prevent="moving = null"
        >
          <select v-model="moveGroup" aria-label="Cílová skupina">
            <option v-for="g in cms.writableGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <select v-model="moveCategory" aria-label="Cílová kategorie">
            <option :value="null">(bez kategorie)</option>
            <option v-for="c in cms.categoriesOf(moveGroup)" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="act" @click.stop="commitMove">Přesunout</button>
          <button class="act" @click.stop="moving = null">Zrušit</button>
        </div>
      </template>
    </div>

    <p class="hint muted">↑↓ výběr · Enter otevřít · F2 přejmenovat · Delete archivovat</p>
  </div>
</template>

<style scoped>
.cms {
  display: grid;
  gap: 0.4rem;
  padding: 0.5rem 0.4rem;
}

.message {
  margin: 0;
  font-size: 0.85rem;
}

.notice {
  color: var(--accent);
}

.create {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.3rem;
}

.create input {
  grid-column: 1;
}

.create select,
.create button {
  grid-column: 2;
}

.create button {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.2rem 0.5rem;
  font-size: 0.8rem;
  color: var(--fg-dim);
}

.create button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--fg);
}

.tree {
  outline: none;
  display: grid;
  gap: 1px;
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  /* Indentation per tree level, from the row's own depth. */
  padding-left: calc(0.3rem + var(--depth) * 0.7rem);
  border-radius: 4px;
  cursor: pointer;
  min-height: 1.5rem;
}

.row:hover {
  background: var(--bg-hover);
}

.row:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

.row.selected {
  background: var(--bg-raised);
  box-shadow: inset 2px 0 0 var(--accent);
}

.row.group .label,
.row.category .label {
  font-weight: 600;
}

.icon {
  width: 0.8rem;
  text-align: center;
  font-size: 0.75rem;
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rename {
  flex: 1;
  min-width: 0;
  font-size: 0.9em;
}

.count {
  font-size: 0.7rem;
}

.badge {
  font-family: var(--mono);
  font-size: 0.65rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: var(--bg-hover);
  color: var(--fg-dim);
  white-space: nowrap;
}

.badge[data-state='Published'] {
  color: var(--accent);
}

.badge[data-state='Draft'] {
  color: #e8b464;
}

.actions {
  display: none;
  gap: 0.15rem;
}

.row:hover .actions,
.row:focus-within .actions,
.row.selected .actions {
  display: inline-flex;
}

.act {
  font-size: 0.75rem;
  color: var(--fg-dim);
  padding: 0 0.2rem;
  border-radius: 3px;
}

.act:hover {
  background: var(--bg);
  color: var(--fg);
}

.act.danger:hover {
  color: var(--danger);
}

/* The move form: one indented line under its document, not a tree row. */
.move {
  display: flex;
  gap: 0.3rem;
  align-items: center;
  padding: 0.25rem 0.3rem 0.25rem calc(0.3rem + var(--depth) * 0.7rem);
  border-left: 2px solid var(--accent);
}

.move select {
  font-size: 0.78rem;
  max-width: 8rem;
}

.hint {
  font-size: 0.7rem;
  margin: 0;
}
</style>
