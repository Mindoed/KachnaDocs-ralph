import type {
  CategoryDto,
  DiffDto,
  DocumentDto,
  DocumentState,
  EffectiveGrant,
  GroupDto,
  Permission,
  VersionDto,
  VersionSummaryDto,
} from '@kachnadocs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, ApiError } from '../api';

/**
 * The CMS view's state (SPEC.md §1): the hierarchy, the current selection, and
 * the version panel's data.
 *
 * Capability is computed here rather than asked of the API per click, from
 * `GET /permissions/effective` plus the group tree — which is exactly the
 * inheritance the backend resolves in SQL. That computation is **UX only**
 * (PLAN.md §3.5): every action below still calls the API and still handles a
 * 404, because hiding a button is not what makes the endpoint safe. A user with
 * a hand-crafted fetch() is not stopped by anything in this file, and the e2e
 * suite is where that is actually proven.
 */
const RANK: Record<Permission, number> = { READ: 1, WRITE: 2, MANAGE: 3 };

export interface TreeNode {
  key: string;
  kind: 'group' | 'category' | 'document';
  id: string;
  label: string;
  depth: number;
  document?: DocumentDto;
  documentCount?: number;
}

/** A document plus the groups it sits under, closest first — for inheritance. */
function groupChain(groups: GroupDto[], start: string | null): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const chain: string[] = [];
  let cursor = start;
  // The guard is belt-and-braces: the backend rejects cycles in SQL
  // (migration 1740000007000), so a repeated id here would mean that broke.
  while (cursor && chain.length <= groups.length + 1) {
    chain.push(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return chain;
}

export const useCmsStore = defineStore('cms', () => {
  const groups = ref<GroupDto[]>([]);
  const categories = ref<CategoryDto[]>([]);
  const documents = ref<DocumentDto[]>([]);
  const grants = ref<EffectiveGrant[]>([]);

  const selectedId = ref<string | null>(null);
  const versions = ref<VersionSummaryDto[]>([]);
  const opened = ref<VersionDto | null>(null);
  const diff = ref<DiffDto | null>(null);

  const loading = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  /** Last action's outcome, shown until the next action; a refusal belongs here too. */
  const notice = ref<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const [g, c, d, e] = await Promise.all([
        api<GroupDto[]>('/groups'),
        api<CategoryDto[]>('/categories'),
        api<DocumentDto[]>('/documents'),
        api<{ grants: EffectiveGrant[] }>('/permissions/effective'),
      ]);
      groups.value = g;
      categories.value = c;
      documents.value = d;
      grants.value = e.grants;
      // A document that vanished underneath us (deleted by someone else) must
      // not stay selected with a stale history panel next to it.
      if (selectedId.value && !d.some((doc) => doc.id === selectedId.value)) {
        selectedId.value = null;
        versions.value = [];
        opened.value = null;
        diff.value = null;
      }
    } catch (err) {
      error.value = err instanceof ApiError ? err.message : 'Nepodařilo se načíst dokumentaci.';
    } finally {
      loading.value = false;
    }
  }

  /**
   * Load on first panel to mount, at most once, without the panels having to
   * know about each other.
   *
   * The tree and the history panel are separately dockable views that can be
   * opened in either order and hidden independently, so neither can own the
   * initial fetch — hiding the left sidebar would leave the history panel
   * showing nothing. Concurrent calls share one request rather than firing two
   * identical round-trips at mount.
   */
  const loaded = ref(false);
  let inflight: Promise<void> | null = null;

  function ensureLoaded(): Promise<void> {
    if (loaded.value) return Promise.resolve();
    inflight ??= load().then(() => {
      loaded.value = true;
      inflight = null;
    });
    return inflight;
  }

  /**
   * Best permission held on a target. Direct grants count; for a document, a
   * grant on any ancestor group reaches it, which is the inheritance the backend
   * resolves in SQL. `NONE` never appears in `EffectiveGrant` (it is a denial, not
   * a permission), so a document-level override that subtracts reach cannot be
   * modelled here — hence `can()` only ever *adds* affordances and the API's 404
   * is the real answer.
   */
  function best(targetKind: 'group' | 'document', id: string, chain: string[]): Permission | null {
    const ancestors = new Set(chain);
    let held: Permission | null = null;
    for (const g of grants.value) {
      const reaches =
        g.targetId === id
          ? g.targetKind === targetKind
          : targetKind === 'document' && g.targetKind === 'group' && ancestors.has(g.targetId);
      if (!reaches) continue;
      if (!held || RANK[g.permission] > RANK[held]) held = g.permission;
    }
    return held;
  }

  function canRead(id: string): boolean {
    const doc = documents.value.find((d) => d.id === id);
    return best('document', id, doc ? groupChain(groups.value, doc.groupId) : []) !== null;
  }

  function can(id: string, required: Permission): boolean {
    const doc = documents.value.find((d) => d.id === id);
    const held = best('document', id, doc ? groupChain(groups.value, doc.groupId) : []);
    return held !== null && RANK[held] >= RANK[required];
  }

  /** Groups the caller may create inside — WRITE on the group is what creation needs. */
  const writableGroups = computed(() =>
    groups.value.filter((g) => {
      const held = best('group', g.id, groupChain(groups.value, g.parentId));
      return held !== null && RANK[held] >= RANK.WRITE;
    }),
  );

  /**
   * Categories of a group, for the move form. Filtered by the group being moved
   * *into*, because `documents.category_id` must belong to
   * `documents.group_id` — the API rejects the mismatch (asserted in
   * cms-crud.e2e-spec.ts), so offering one would only guarantee an error.
   */
  function categoriesOf(groupId: string): CategoryDto[] {
    return categories.value.filter((c) => c.groupId === groupId).sort((a, b) => a.position - b.position);
  }

  /**
   * The tree, flattened in display order: group > category > document, with a
   * group's uncategorised documents after its categories.
   *
   * Roots are the groups with no parent **plus** any group whose parent is not
   * itself visible. A caller with READ on Payroll but not on HR still gets
   * Payroll at the top level — dropping it would hide documents they are
   * allowed to read, which is the opposite of what a tree filter should do.
   *
   * The invariant the whole function exists to keep is at the bottom: **every
   * document `GET /documents` returned has a row here.** The API has already
   * decided the caller may read it (PLAN §3.1 filters in SQL), so a tree that
   * silently drops it is not a security filter but a lost document — the bug
   * this file was wrong about, see the sweep below.
   */
  const tree = computed<TreeNode[]>(() => {
    const out: TreeNode[] = [];
    const known = new Set(groups.value.map((g) => g.id));
    // Which headers and rows have already been emitted, so the sweep at the end
    // can fill a gap without duplicating a node. Vue keys rows by `key`, so a
    // repeated one is a mis-render rather than an error — hence the bookkeeping.
    const placedKeys = new Set<string>();
    const placedDocs = new Set<string>();
    const groupDepth = new Map<string, number>();

    const push = (node: TreeNode): void => {
      if (node.kind === 'document') placedDocs.add(node.id);
      else placedKeys.add(node.key);
      if (node.kind === 'group') groupDepth.set(node.id, node.depth);
      out.push(node);
    };

    const sortDocs = (docs: DocumentDto[]): DocumentDto[] =>
      [...docs].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, 'cs'));

    const documentsIn = (groupId: string, categoryId: string | null): DocumentDto[] =>
      sortDocs(documents.value.filter((d) => d.groupId === groupId && d.categoryId === categoryId));

    const documentNode = (d: DocumentDto, depth: number): TreeNode => ({
      key: `d-${d.id}`,
      kind: 'document',
      id: d.id,
      label: d.title,
      depth,
      document: d,
    });

    const emitDocuments = (groupId: string, categoryId: string | null, depth: number): void => {
      for (const d of documentsIn(groupId, categoryId)) push(documentNode(d, depth));
    };

    const walked = new Set<string>();
    const walk = (group: GroupDto, depth: number): void => {
      // Guards the orphan pass below: a group reachable from a root must not be
      // emitted twice, and a cycle must not recurse forever.
      if (walked.has(group.id)) return;
      walked.add(group.id);
      push({
        key: `g-${group.id}`,
        kind: 'group',
        id: group.id,
        label: group.name,
        depth,
        documentCount: group.documentCount,
      });
      for (const c of categories.value
        .filter((cat) => cat.groupId === group.id)
        .sort((a, b) => a.position - b.position)) {
        push({
          key: `c-${c.id}`,
          kind: 'category',
          id: c.id,
          label: c.name,
          depth: depth + 1,
          documentCount: c.documentCount,
        });
        emitDocuments(group.id, c.id, depth + 2);
      }
      emitDocuments(group.id, null, depth + 1);
      for (const child of groups.value
        .filter((g) => g.parentId === group.id)
        .sort((a, b) => a.name.localeCompare(b.name, 'cs'))) {
        walk(child, depth + 1);
      }
    };

    const roots = groups.value
      .filter((g) => g.parentId === null || !known.has(g.parentId))
      .sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    for (const root of roots) walk(root, 0);

    // A group unreachable from every root — which the SQL cycle guard in
    // migration 1740000007000 is supposed to make impossible — is still listed
    // rather than silently dropped along with its documents.
    for (const leftover of groups.value.filter((g) => !walked.has(g.id))) walk(leftover, 0);

    // The sweep that keeps the invariant: anything still unplaced gets a row,
    // under a header synthesised from the names the document itself carries
    // (`groupName`, `categoryName` — both on every row, so no extra request).
    //
    // Two distinct shapes land here, and `walk` cannot reach either:
    //
    //  1. The caller's *group* is invisible. This is the ordinary case for a
    //     direct document grant: `GET /groups` resolves group grants, so someone
    //     granted READ on one document (Carl in the seed) gets that document and
    //     no groups at all.
    //  2. `documents.category_id` points at a category belonging to a *different*
    //     group than `documents.group_id`. `POST /documents` rejects that
    //     mismatch, but `PATCH /categories/:id` moves a category between groups
    //     and leaves the documents' `group_id` behind, so the row matches neither
    //     `emitDocuments(group.id, c.id)` — the category was filed elsewhere —
    //     nor `emitDocuments(group.id, null)`.
    //
    // Shape 1 is why this pass exists at all; it used to emit only
    // `categoryId === null`, which is what hid the reported document. Shape 2 is
    // the same mistake one level up, so the guarantee is stated over *documents*
    // rather than over any one combination of group and category — the next shape
    // nobody has thought of is covered by construction.
    const strays = documents.value.filter((d) => !placedDocs.has(d.id));
    const strayGroups = new Map<string, { name: string; docs: DocumentDto[] }>();
    for (const d of strays) {
      const entry = strayGroups.get(d.groupId) ?? { name: d.groupName, docs: [] };
      entry.docs.push(d);
      strayGroups.set(d.groupId, entry);
    }

    for (const [groupId, { name, docs }] of [...strayGroups.entries()].sort((a, b) =>
      a[1].name.localeCompare(b[1].name, 'cs'),
    )) {
      // Under a visible group the header `walk` drew is the right home; only a
      // group that was never listed gets one.
      let depth = groupDepth.get(groupId);
      if (depth === undefined) {
        depth = 0;
        push({
          key: `g-${groupId}`,
          kind: 'group',
          id: groupId,
          label: name,
          depth,
          documentCount: undefined,
        });
      }

      // Categorised strays first, then the unfiled ones, matching `walk`'s order.
      // Ordered by category name, because `position` lives on the category rows
      // this caller was never sent.
      const categorised = new Map<string, { name: string; docs: DocumentDto[] }>();
      const unfiled: DocumentDto[] = [];
      for (const d of docs) {
        if (!d.categoryId) {
          unfiled.push(d);
          continue;
        }
        // `categoryName` is null only when the category row is gone, which the
        // ON DELETE SET NULL constraint rules out; the title keeps such a row
        // visible instead of dropping it, which is the whole point here.
        const label = d.categoryName ?? '(kategorie)';
        const entry = categorised.get(d.categoryId) ?? { name: label, docs: [] };
        entry.docs.push(d);
        categorised.set(d.categoryId, entry);
      }

      for (const [categoryId, { name: categoryName, docs: catDocs }] of [...categorised.entries()].sort(
        (a, b) => a[1].name.localeCompare(b[1].name, 'cs'),
      )) {
        // The header is repeated under this group even when `walk` already drew
        // it elsewhere, because shape 2 puts the category and its documents in
        // two different places at once and a document indented one level with no
        // header above it reads as a rendering glitch. Rows are keyed, so the
        // second copy needs a key of its own.
        const key = placedKeys.has(`c-${categoryId}`) ? `c-${categoryId}-in-${groupId}` : `c-${categoryId}`;
        if (!placedKeys.has(key)) {
          push({
            key,
            kind: 'category',
            id: categoryId,
            label: categoryName,
            depth: depth + 1,
            documentCount: undefined,
          });
        }
        for (const d of sortDocs(catDocs)) push(documentNode(d, depth + 2));
      }
      for (const d of sortDocs(unfiled)) push(documentNode(d, depth + 1));
    }
    return out;
  });

  const selected = computed(() => documents.value.find((d) => d.id === selectedId.value) ?? null);

  async function select(id: string): Promise<void> {
    if (selectedId.value === id) return;
    selectedId.value = id;
    opened.value = null;
    diff.value = null;
    versions.value = [];
    try {
      versions.value = await api<VersionSummaryDto[]>(`/documents/${id}/versions`);
    } catch (err) {
      // 404 means no READ *or* no history; the API will not say which, and
      // neither do we — the panel just says "žádná verze".
      if (!(err instanceof ApiError && err.status === 404)) {
        error.value = err instanceof ApiError ? err.message : 'Histori se nepodařilo načíst.';
      }
    }
  }

  async function openVersion(number: number): Promise<void> {
    if (!selectedId.value) return;
    try {
      opened.value = await api<VersionDto>(`/documents/${selectedId.value}/versions/${number}`);
      diff.value = null;
    } catch (err) {
      notice.value = err instanceof ApiError ? err.message : 'Verzi se nepodařilo otevřít.';
    }
  }

  async function compare(number: number): Promise<void> {
    if (!selectedId.value) return;
    try {
      diff.value = await api<DiffDto>(`/documents/${selectedId.value}/versions/${number}/diff`);
      opened.value = null;
    } catch (err) {
      notice.value = err instanceof ApiError ? err.message : 'Srovnání se nepodařilo provést.';
    }
  }

  /** Runs an action, refreshes, and reports a refusal instead of throwing. */
  async function act(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    busy.value = true;
    notice.value = null;
    error.value = null;
    try {
      await fn();
      await load();
      notice.value = label;
      return true;
    } catch (err) {
      notice.value = err instanceof ApiError ? `${label}: ${err.message}` : `${label}: akce selhala.`;
      return false;
    } finally {
      busy.value = false;
    }
  }

  const create = (title: string, groupId: string, categoryId?: string | null) =>
    act('Vytvořeno', () =>
      api<DocumentDto>('/documents', {
        method: 'POST',
        body: JSON.stringify({ title, groupId, categoryId: categoryId ?? null }),
      }),
    );

  const rename = (id: string, title: string) =>
    act('Přejmenováno', () => api(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }));

  const move = (id: string, groupId: string, categoryId: string | null) =>
    act('Přesunuto', () =>
      api(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ groupId, categoryId }) }),
    );

  const reorder = (id: string, position: number) =>
    act('Změněno pořadí', () =>
      api(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ position }) }),
    );

  const setState = (id: string, state: DocumentState) =>
    act(state === 'Archived' ? 'Archivováno' : 'Obnoveno', () =>
      api(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ state }) }),
    );

  const remove = (id: string) =>
    act('Smazáno', () => api(`/documents/${id}`, { method: 'DELETE' })).then((ok) => {
      if (ok && selectedId.value === id) selectedId.value = null;
      return ok;
    });

  const publish = (comment: string) =>
    act('Publikováno', () =>
      api(`/documents/${selectedId.value ?? ''}/publish`, {
        method: 'POST',
        body: JSON.stringify(comment ? { comment } : {}),
      }),
    ).then(async (ok) => {
      if (ok && selectedId.value) {
        versions.value = await api<VersionSummaryDto[]>(`/documents/${selectedId.value}/versions`);
      }
      return ok;
    });

  const restore = (number: number) =>
    act(`Obnoveno z v${number} do konceptu`, () =>
      api(`/documents/${selectedId.value ?? ''}/versions/${number}/restore`, { method: 'POST' }),
    );

  return {
    groups,
    categories,
    documents,
    grants,
    selectedId,
    selected,
    tree,
    versions,
    opened,
    diff,
    loading,
    busy,
    error,
    notice,
    writableGroups,
    categoriesOf,
    load,
    ensureLoaded,
    select,
    can,
    canRead,
    create,
    rename,
    move,
    reorder,
    setState,
    remove,
    publish,
    restore,
    openVersion,
    compare,
  };
});
