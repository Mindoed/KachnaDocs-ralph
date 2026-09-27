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
   */
  const tree = computed<TreeNode[]>(() => {
    const out: TreeNode[] = [];
    const known = new Set(groups.value.map((g) => g.id));

    const documentsIn = (groupId: string, categoryId: string | null): DocumentDto[] =>
      documents.value
        .filter((d) => d.groupId === groupId && d.categoryId === categoryId)
        .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, 'cs'));

    const emitDocuments = (groupId: string, categoryId: string | null, depth: number): void => {
      for (const d of documentsIn(groupId, categoryId)) {
        out.push({ key: `d-${d.id}`, kind: 'document', id: d.id, label: d.title, depth, document: d });
      }
    };

    const walked = new Set<string>();
    const walk = (group: GroupDto, depth: number): void => {
      // Guards the orphan pass below: a group reachable from a root must not be
      // emitted twice, and a cycle must not recurse forever.
      if (walked.has(group.id)) return;
      walked.add(group.id);
      out.push({
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
        out.push({
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

    // Documents whose *group* the caller cannot see. This is the ordinary case
    // for a direct document grant: `GET /groups` resolves group grants, so
    // someone granted READ on one document (Carl in the seed fixture) receives
    // that document and no groups at all. Rendering only what /groups returned
    // would hide a document the API just said they may read, so each such group
    // gets a header from the name the document itself carries.
    const byGroup = new Map<string, string>();
    for (const d of documents.value) {
      if (!walked.has(d.groupId)) byGroup.set(d.groupId, d.groupName);
    }
    for (const [groupId, name] of [...byGroup.entries()].sort((a, b) => a[1].localeCompare(b[1], 'cs'))) {
      out.push({
        key: `g-${groupId}`,
        kind: 'group',
        id: groupId,
        label: name,
        depth: 0,
        documentCount: undefined,
      });
      emitDocuments(groupId, null, 1);
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
