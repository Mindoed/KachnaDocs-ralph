<script setup lang="ts">
import { computed, type Component } from 'vue';
import type { ViewDescriptor } from '../stores/layout';
import PermissionsPanel from './PermissionsPanel.vue';

const props = defineProps<{ view: ViewDescriptor }>();

/**
 * Views arrive per phase; each is a panel registered here and nothing else.
 * Code-splitting per view can wait until there is a heavy one (the editor).
 */
const PANELS: Record<string, Component> = {
  permissions: PermissionsPanel,
};

const panel = computed(() => PANELS[props.view.id] ?? null);
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <h2>{{ view.title }}</h2>
    </header>
    <component :is="panel" v-if="panel" />
    <p v-else class="muted placeholder">Pohled zatím není implementován — přidá se ve vlastní fázi.</p>
  </section>
</template>

<style scoped>
.panel {
  border-bottom: 1px solid var(--border);
}

.panel-head {
  padding: 0.5rem 0.6rem 0;
}

.placeholder {
  padding: 0.6rem;
  font-size: 0.85rem;
}
</style>
