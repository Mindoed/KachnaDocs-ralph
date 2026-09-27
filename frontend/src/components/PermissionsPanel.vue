<script setup lang="ts">
import type { EffectiveGrant, PermissionSource } from '@kachnadocs/shared';
import { onMounted, ref } from 'vue';
import { api, ApiError } from '../api';
import { useAuthStore } from '../stores/auth';
import GrantEditor from './GrantEditor.vue';

const auth = useAuthStore();

const grants = ref<EffectiveGrant[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const SOURCE_LABEL: Record<PermissionSource['kind'], string> = {
  direct: 'přiděleno přímo',
  inherited: 'zděděno',
  role: 'z role',
  'role-inherited': 'zděděno z role',
};

function describe(source: PermissionSource): string {
  switch (source.kind) {
    case 'direct':
      return SOURCE_LABEL.direct;
    case 'role':
      return `${SOURCE_LABEL.role} ${source.roleName}`;
    case 'inherited':
      return `${SOURCE_LABEL.inherited} z ${source.viaTargetName}`;
    case 'role-inherited':
      return `${SOURCE_LABEL['role-inherited']} — ${source.roleName} přes ${source.viaTargetName}`;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await api<{ grants: EffectiveGrant[] }>('/permissions/effective');
    grants.value = res.grants;
  } catch (err) {
    // A 404 here can mean "no such user" or "not yours to inspect"; the API
    // deliberately does not distinguish them, so neither do we.
    error.value = err instanceof ApiError ? err.message : 'Nepodařilo se načíst oprávnění.';
    grants.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<!--
  Effective permissions of the caller (SPEC.md:80, :84) plus, for anyone who
  manages something, the grant editor (SPEC.md:88). The editor refetches this
  list on every change so a manager granting themselves WRITE sees it appear
  rather than having to reload — and so the two views cannot disagree.
-->
<template>
  <div class="permissions">
    <div class="toolbar">
      <button :disabled="loading" @click="load">{{ loading ? 'Načítám…' : 'Obnovit' }}</button>
    </div>

    <GrantEditor @changed="load" />

    <h3 class="heading">Efektivní oprávnění</h3>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading && !grants" class="muted">Načítám…</p>

    <template v-else-if="grants">
      <p v-if="grants.length === 0" class="muted empty">{{ auth.user?.displayName }} nemá žádná oprávnění.</p>
      <ul v-else class="grants">
        <li v-for="g in grants" :key="`${g.targetKind}-${g.targetId}-${g.permission}`">
          <span class="badge" :data-permission="g.permission">{{ g.permission }}</span>
          <span class="target">
            <span class="kind muted">{{ g.targetKind === 'group' ? 'skupina' : 'dokument' }}</span>
            {{ g.targetName }}
          </span>
          <span class="source muted">{{ describe(g.source) }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.permissions {
  padding: 0.5rem 0.6rem;
  display: grid;
  gap: 0.5rem;
}

.toolbar {
  display: flex;
  gap: 0.4rem;
}

/* Same voice as the editor's headings so the two sections read as one panel. */
.heading {
  margin: 0;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
}

.toolbar button {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.2rem 0.5rem;
  font-size: 0.8rem;
  color: var(--fg-dim);
}

.toolbar button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--fg);
}

.grants {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.3rem;
}

.grants li {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.1rem 0.45rem;
  padding: 0.3rem 0.35rem;
  border: 1px solid var(--border);
  border-radius: 5px;
}

.badge {
  font-family: var(--mono);
  font-size: 0.7rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: var(--bg-hover);
  align-self: start;
}

.badge[data-permission='MANAGE'] {
  color: #e8b464;
}

.badge[data-permission='WRITE'] {
  color: var(--accent);
}

.target {
  min-width: 0;
  overflow-wrap: anywhere;
}

.kind {
  font-size: 0.75rem;
  margin-right: 0.25rem;
}

.source {
  grid-column: 2;
  font-size: 0.75rem;
}

.empty {
  font-size: 0.85rem;
}
</style>
