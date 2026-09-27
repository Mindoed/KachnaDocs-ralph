<script setup lang="ts">
import type { GrantKind, Permission } from '@kachnadocs/shared';
import { onMounted, ref, watch } from 'vue';
import { api, ApiError } from '../api';

interface Subject {
  kind: 'user' | 'discord_role';
  id: string;
  name: string;
}
interface Target {
  kind: 'group' | 'document';
  id: string;
  name: string;
}
interface Grant {
  id: string;
  subject_kind: 'user' | 'discord_role';
  subject_name: string;
  target_kind: 'group' | 'document';
  target_name: string;
  permission: GrantKind;
}

const emit = defineEmits<{ changed: [] }>();

const subjects = ref<Subject[]>([]);
const targets = ref<Target[]>([]);
const explicit = ref<Grant[]>([]);

const subjectQuery = ref('');
const targetQuery = ref('');
const subjectId = ref('');
const targetId = ref('');
/** GrantKind, not Permission: the form can also store the NONE deny override. */
const permission = ref<GrantKind>('READ');

const canManage = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/**
 * The three rungs, plus `NONE` — SPEC.md:82's explicit deny, which overrides an
 * inherited grant at document level.
 *
 * `NONE` is not a fourth rung: it means "nothing, and this beats inheritance".
 * So it is separated from the ladder by a non-selectable heading rather than
 * sitting in the same list where it would read as "less than READ". The
 * explanation below the select carries the rest of the meaning, because the one
 * thing a manager needs to understand before clicking it is that it wins over
 * the group inheritance they may not even be able to see from here.
 */
const LADDER: Permission[] = ['READ', 'WRITE', 'MANAGE'];
const DENY: GrantKind = 'NONE';

const KIND_LABEL: Record<Subject['kind'] | Target['kind'], string> = {
  user: 'uživatel',
  discord_role: 'role',
  group: 'skupina',
  document: 'dokument',
};

async function load(): Promise<void> {
  error.value = null;
  try {
    // One call decides it: /permissions/subjects answers 404 both when the
    // caller manages nothing and when the route is missing, which is exactly the
    // API's rule, so the form hides itself instead of inventing its own check.
    const [s, t, g] = await Promise.all([
      api<{ subjects: Subject[] }>(`/permissions/subjects?q=${encodeURIComponent(subjectQuery.value)}`),
      api<{ targets: Target[] }>(`/permissions/targets?q=${encodeURIComponent(targetQuery.value)}`),
      api<Grant[]>('/permissions'),
    ]);
    subjects.value = s.subjects;
    targets.value = t.targets;
    explicit.value = g;
    canManage.value = true;
  } catch (err) {
    canManage.value = false;
    explicit.value = [];
    error.value = err instanceof ApiError && err.status !== 404 ? err.message : null;
  }
}

// Debounced so typing a name is not one request per keystroke; the lists are
// small today, but a directory of hundreds should not hammer the API.
let timer: ReturnType<typeof setTimeout> | undefined;
watch([subjectQuery, targetQuery], () => {
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 250);
});

async function add(): Promise<void> {
  if (!subjectId.value || !targetId.value) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    const subject = subjects.value.find((s) => s.id === subjectId.value);
    const target = targets.value.find((t) => t.id === targetId.value);
    if (!subject || !target) return;
    await api('/permissions', {
      method: 'POST',
      body: JSON.stringify({
        subjectKind: subject.kind,
        subjectId: subject.id,
        targetKind: target.kind,
        targetId: target.id,
        permission: permission.value,
      }),
    });
    notice.value = `Uděleno ${permission.value} — ${subject.name} → ${target.name}`;
    await load();
    emit('changed');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Udělení oprávnění selhalo.';
  } finally {
    busy.value = false;
  }
}

async function revoke(grant: Grant): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await api(`/permissions/${grant.id}`, { method: 'DELETE' });
    await load();
    emit('changed');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Zrušení oprávnění selhalo.';
  } finally {
    busy.value = false;
  }
}

onMounted(load);
defineExpose({ load });
</script>

<!--
  SPEC.md:88 — search for and grant rights to a user or a Discord role. Subjects
  and targets come from the API rather than free-text UUIDs, so the form cannot
  submit an id the caller may not use; the server enforces the same rule again
  (backend/src/acl/permissions.controller.ts), and hiding this form is a
  convenience, never the control.
-->
<template>
  <section v-if="canManage" class="editor">
    <h3>Správa oprávnění</h3>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="muted notice">{{ notice }}</p>

    <div class="form">
      <label>
        <span class="muted">Komu</span>
        <input v-model="subjectQuery" placeholder="jméno uživatele nebo role" />
        <select v-model="subjectId">
          <option value="">— vyberte —</option>
          <option v-for="s in subjects" :key="`s-${s.kind}-${s.id}`" :value="s.id">
            {{ s.name }} ({{ KIND_LABEL[s.kind] }})
          </option>
        </select>
      </label>

      <label>
        <span class="muted">Na co</span>
        <input v-model="targetQuery" placeholder="název skupiny nebo dokumentu" />
        <select v-model="targetId">
          <option value="">— vyberte —</option>
          <option v-for="t in targets" :key="`t-${t.kind}-${t.id}`" :value="t.id">
            {{ t.name }} ({{ KIND_LABEL[t.kind] }})
          </option>
        </select>
      </label>

      <label>
        <span class="muted">Oprávnění</span>
        <select v-model="permission">
          <option v-for="p in LADDER" :key="p" :value="p">{{ p }}</option>
          <option disabled>———</option>
          <option :value="DENY">NONE — explicitní zamítnutí</option>
        </select>
      </label>
      <p v-if="permission === DENY" class="deny-note muted">
        NONE cíl uzavře i tomu, kdo má přístup zděděný přes skupinu. Slouží k výjimce „nesmí to vidět“ u
        jednotlivého dokumentu.
      </p>

      <button class="primary" :disabled="busy || !subjectId || !targetId" @click="add">Přidat</button>
    </div>

    <h4>Přímé granty</h4>
    <p v-if="explicit.length === 0" class="muted empty">Žádné přímé granty na spravovaných cílech.</p>
    <ul v-else class="explicit">
      <li v-for="g in explicit" :key="g.id">
        <span class="badge" :data-permission="g.permission">{{ g.permission }}</span>
        <span class="pair">
          <strong>{{ g.subject_name }}</strong>
          <span class="muted">({{ KIND_LABEL[g.subject_kind] }})</span>
          → {{ g.target_name }}
          <span class="muted">({{ KIND_LABEL[g.target_kind] }})</span>
        </span>
        <button class="revoke" :disabled="busy" title="Zrušit grant" @click="revoke(g)">zrušit</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* Negative horizontal margin so the divider spans the panel edge to edge while
   the content stays aligned with the padding the panel already applies. */
.editor {
  margin: 0 -0.6rem;
  padding: 0.5rem 0.6rem;
  border-top: 1px solid var(--border);
  display: grid;
  gap: 0.5rem;
}

h3,
h4 {
  margin: 0;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
}

.form {
  display: grid;
  gap: 0.4rem;
}

label {
  display: grid;
  gap: 0.2rem;
  font-size: 0.8rem;
}

.form input,
.form select {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.25rem 0.35rem;
  color: var(--fg);
  font: inherit;
}

.primary {
  background: var(--accent);
  color: #fff;
  border-radius: 4px;
  padding: 0.3rem;
  font-size: 0.8rem;
}

.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.explicit {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.25rem;
}

.explicit li {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0.25rem 0.35rem;
}

.badge {
  font-family: var(--mono);
  font-size: 0.68rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: var(--bg-hover);
}

.badge[data-permission='MANAGE'] {
  color: #e8b464;
}

.badge[data-permission='WRITE'] {
  color: var(--accent);
}

/* NONE is a denial, so it wears the danger colour rather than a fourth rung's. */
.badge[data-permission='NONE'] {
  color: var(--danger);
}

.deny-note {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 0.75rem;
}

.pair {
  min-width: 0;
  overflow-wrap: anywhere;
}

.revoke {
  color: var(--fg-dim);
  font-size: 0.72rem;
}

.revoke:hover:not(:disabled) {
  color: var(--fg);
}

.notice {
  font-size: 0.78rem;
  margin: 0;
}

.empty {
  font-size: 0.78rem;
  margin: 0;
}
</style>
