<script setup lang="ts">
import { computed } from 'vue';
import { DOCKS, useLayoutStore, type Dock } from '../stores/layout';
import { useAuthStore } from '../stores/auth';
import { useCmsStore } from '../stores/cms';
import PanelHost from './PanelHost.vue';
import { followSelection } from '../editor/deepLink';

const layout = useLayoutStore();
const auth = useAuthStore();
const cms = useCmsStore();

// The URL follows the tree selection; the editor panel does the opposite (it selects
// in the store when the URL names a document). Each side no-ops when the other has
// already caught up, so the two watchers settle instead of looping.
followSelection(computed(() => cms.selectedId));

const roleNames = computed(() => (auth.user?.roles ?? []).map((r) => r.name).join(', ') || '—');

const TITLES: Record<Dock, string> = { left: 'Navigace', main: 'Obsah', right: 'Kontext' };
</script>

<!--
  Layout is a vertical stack (work area + status bar). The work area is a
  horizontal flex row: ribbon, then only the visible docks. Flex rather than a
  fixed grid template because a hidden dock must remove itself from flow — a
  grid track would keep reserving its column and leave a gap where the sidebar
  was. Dock widths live in CSS.
-->
<template>
  <div class="workbench">
    <div class="body">
      <nav class="ribbon" aria-label="Pohledy">
        <button
          v-for="view in layout.available"
          :key="view.id"
          class="ribbon-btn"
          :class="{ active: layout.focused === view.id }"
          :title="`${view.title} — ${layout.dockOf[view.id]}`"
          @click="layout.focus(view.id)"
        >
          <span class="glyph">{{ view.icon }}</span>
        </button>
        <span class="spacer" />
        <button class="ribbon-btn" title="Obnovit rozložení" @click="layout.reset">⟲</button>
      </nav>

      <template v-for="dock in DOCKS" :key="dock">
        <section v-if="layout.visible[dock]" class="dock" :class="dock">
          <header class="dock-head">
            <span>{{ TITLES[dock] }}</span>
            <button class="close" :title="`Skrýt ${TITLES[dock]}`" @click="layout.toggleDock(dock)">×</button>
          </header>
          <div class="dock-body">
            <PanelHost v-for="view in layout.viewsIn(dock)" :key="view.id" :view="view" />
            <p v-if="layout.viewsIn(dock).length === 0" class="muted empty">
              Žádný pohled — klikněte na ikonu v liště vlevo.
            </p>
          </div>
        </section>
      </template>
    </div>

    <footer class="status">
      <span>{{ auth.user?.displayName }}</span>
      <span class="muted">role: {{ roleNames }}</span>
      <span class="spacer" />
      <button v-for="dock in DOCKS" :key="dock" class="toggle" @click="layout.toggleDock(dock)">
        {{ layout.visible[dock] ? '◉' : '○' }} {{ TITLES[dock] }}
      </button>
      <button class="toggle" @click="auth.logout()">Odhlásit</button>
    </footer>
  </div>
</template>

<style scoped>
.workbench {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.ribbon {
  width: 46px;
  flex: none;
  background: var(--bg-raised);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.4rem 0;
  gap: 0.15rem;
}

.ribbon-btn {
  width: 38px;
  height: 38px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-dim);
}

.ribbon-btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.ribbon-btn.active {
  background: var(--bg-hover);
  color: var(--accent);
  box-shadow: inset 2px 0 0 var(--accent);
}

.glyph {
  font-size: 1.1rem;
}

.spacer {
  flex: 1;
}

.dock {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.dock.left {
  flex: 1 1 220px;
  border-right: 1px solid var(--border);
}

/* The main dock takes the slack; sidebars only grow from their base width. */
.dock.main {
  flex: 3 1 0;
}

.dock.right {
  flex: 1 1 260px;
  border-left: 1px solid var(--border);
}

.dock-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.4rem 0.6rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  border-bottom: 1px solid var(--border);
}

.close {
  color: var(--fg-dim);
  font-size: 1rem;
  line-height: 1;
}

.dock-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.empty {
  padding: 1rem;
  font-size: 0.85rem;
}

.status {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.3rem 0.6rem;
  background: var(--bg-raised);
  border-top: 1px solid var(--border);
  font-size: 0.8rem;
}

.toggle {
  color: var(--fg-dim);
  font-size: 0.8rem;
}

.toggle:hover {
  color: var(--fg);
}
</style>
