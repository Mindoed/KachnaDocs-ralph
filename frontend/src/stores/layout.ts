import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

/**
 * Where a view may live (SPEC.md "Hlavní pohledy", PLAN §2.6). VS Code-like:
 * an activity ribbon selects a view; the view renders in one of three docks.
 * No view decides its own dock — that is what makes positions user-changeable
 * and keeps phase 2-5 views from inventing their own placement.
 */
export const DOCKS = ['left', 'main', 'right'] as const;
export type Dock = (typeof DOCKS)[number];

export interface ViewDescriptor {
  id: string;
  /** Ribbon label. */
  title: string;
  /** Single-glyph ribbon icon; real icons arrive with the design pass. */
  icon: string;
  /** Default dock, used on first open. A judgement call, recorded in FINDINGS. */
  preferredDock: Dock;
  /** Only shown when the capability exists, so unfinished phases stay hidden. */
  available: boolean;
}

/**
 * Dock assignments chosen now and written to ralph/FINDINGS.md as PLAN §2.6
 * requires:
 *  - cms: documents are the primary object, so the tree lives in the left
 *    sidebar next to the ribbon that opens it, leaving the main area for content
 *  - editor: widest surface, needs the main area
 *  - versions: the other half of the CMS interaction — the tree picks a
 *    document, history reads it — so it sits opposite the tree rather than
 *    competing with it for the left sidebar. SPEC.md §1 asks for a "version
 *    history panel", which reads as its own view, and PLAN §2.6 lets a module be
 *    a view; that keeps both panels movable.
 *  - permissions / tasks / chat: reference surfaces consulted while reading a
 *    document, so the right sidebar; chat is also the only view worth keeping
 *    open beside a document
 */
export const VIEWS: ViewDescriptor[] = [
  { id: 'cms', title: 'Dokumentace', icon: '🗂', preferredDock: 'left', available: true },
  {
    id: 'versions',
    title: 'Historie verzí',
    icon: '🕘',
    preferredDock: 'right',
    available: true,
  },
  { id: 'editor', title: 'Editor', icon: '✎', preferredDock: 'main', available: true },
  { id: 'permissions', title: 'Oprávnění', icon: '🔐', preferredDock: 'right', available: true },
  { id: 'tasks', title: 'Úkoly', icon: '☑', preferredDock: 'right', available: false },
  { id: 'chat', title: 'AI chat', icon: '✦', preferredDock: 'right', available: true },
];

const STORAGE_KEY = 'kachnadocs.layout.v1';

interface PersistedLayout {
  dockOf: Record<string, Dock>;
  visible: Record<Dock, boolean>;
  focused: string | null;
}

function readPersisted(): PersistedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedLayout) : null;
  } catch {
    return null;
  }
}

export const useLayoutStore = defineStore('layout', () => {
  const persisted = readPersisted();

  const available = VIEWS.filter((v) => v.available);
  const defaultDockOf = (): Record<string, Dock> =>
    Object.fromEntries(available.map((v) => [v.id, v.preferredDock]));

  const dockOf = ref<Record<string, Dock>>({ ...defaultDockOf(), ...(persisted?.dockOf ?? {}) });
  const visible = ref<Record<Dock, boolean>>(persisted?.visible ?? { left: true, main: true, right: true });
  /** View the ribbon currently points at; drives the highlighted icon. */
  const focused = ref<string | null>(persisted?.focused ?? available[0]?.id ?? null);

  watch(
    [dockOf, visible, focused],
    () => {
      const payload: PersistedLayout = {
        dockOf: dockOf.value,
        visible: visible.value,
        focused: focused.value,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Private mode / quota: layout simply will not persist. Not worth
        // surfacing an error for a convenience feature.
      }
    },
    { deep: true },
  );

  /**
   * Plain function, not a computed: it reads `dockOf.value` so it stays
   * reactive when called from a template, and a computed created per call
   * would never be cached or disposed.
   */
  function viewsIn(dock: Dock): ViewDescriptor[] {
    return available.filter((v) => dockOf.value[v.id] === dock);
  }

  /** Ribbon click: reveal the dock holding the view and focus it. */
  function focus(viewId: string): void {
    const dock = dockOf.value[viewId];
    if (!dock) return;
    visible.value = { ...visible.value, [dock]: true };
    focused.value = viewId;
  }

  function move(viewId: string, dock: Dock): void {
    dockOf.value = { ...dockOf.value, [viewId]: dock };
    visible.value = { ...visible.value, [dock]: true };
  }

  function toggleDock(dock: Dock): void {
    visible.value = { ...visible.value, [dock]: !visible.value[dock] };
  }

  function reset(): void {
    dockOf.value = defaultDockOf();
    visible.value = { left: true, main: true, right: true };
    focused.value = available[0]?.id ?? null;
  }

  return { dockOf, visible, focused, available, viewsIn, focus, move, toggleDock, reset };
});
