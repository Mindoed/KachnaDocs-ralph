<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const handle = ref('ana');
/** Set when the API offers Discord consent; null means dev mode. */
const discordUrl = ref<string | null>(null);

/** Mirrors backend/src/auth/dev-identity.provider.ts. */
const KNOWN = [
  { handle: 'ana', note: 'role HR — děděné čtení' },
  { handle: 'bona', note: 'role Engineering + přímé MANAGE' },
  { handle: 'carl', note: 'jeden dokument přímo' },
  { handle: 'dana', note: 'bez oprávnění' },
];

// The login form must not guess which mode the server is in: it asks. In real
// mode /auth/dev-login answers 404 (PLAN §3 — denial and absence are
// indistinguishable), so a failure simply means "no Discord button".
onMounted(async () => {
  try {
    const res = await api<{ url: string }>('/auth/discord/authorize-url?state=login');
    discordUrl.value = res.url;
  } catch {
    discordUrl.value = null;
  }
});

async function submit(): Promise<void> {
  await auth.loginWithHandle(handle.value.trim());
}
</script>

<template>
  <main class="login">
    <form class="card" @submit.prevent="submit">
      <h1>KachnaDocs</h1>

      <template v-if="discordUrl">
        <p class="muted">Přihlášení přes Discord.</p>
        <a class="primary discord" :href="discordUrl">Přihlásit přes Discord</a>
      </template>

      <template v-else>
        <p class="muted">
          Vývojové přihlášení (<code>DevIdentityProvider</code>). Reálné Discord OAuth zapnete nastavením
          <code>DISCORD_CLIENT_ID</code> a <code>DISCORD_CLIENT_SECRET</code> — viz
          <code>docs/discord-oauth.md</code>.
        </p>

        <label>
          <span class="muted">Identita</span>
          <input v-model="handle" list="handles" autocomplete="username" autofocus />
        </label>
        <datalist id="handles">
          <option v-for="k in KNOWN" :key="k.handle" :value="k.handle">{{ k.note }}</option>
        </datalist>

        <ul class="hints muted">
          <li v-for="k in KNOWN" :key="k.handle">
            <button type="button" class="link" @click="handle = k.handle">{{ k.handle }}</button>
            — {{ k.note }}
          </li>
        </ul>
      </template>

      <p v-if="auth.error" class="error">{{ auth.error }}</p>
      <button v-if="!discordUrl" class="primary" type="submit" :disabled="auth.loading">
        {{ auth.loading ? 'Přihlašuji…' : 'Přihlásit se' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.login {
  height: 100%;
  display: grid;
  place-items: center;
}

.card {
  width: min(420px, 90vw);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.5rem;
  display: grid;
  gap: 0.75rem;
}

label {
  display: grid;
  gap: 0.25rem;
}

.hints {
  margin: 0;
  padding-left: 1.1rem;
  display: grid;
  gap: 0.15rem;
  font-size: 0.85rem;
}

.link {
  color: var(--accent);
  padding: 0;
  font: inherit;
}

.primary {
  background: var(--accent);
  color: #fff;
  border-radius: 5px;
  padding: 0.5rem;
}

.primary:disabled {
  opacity: 0.6;
  cursor: default;
}

/* The Discord control is an <a> (a full-page redirect to consent), so it has to
   borrow the button's box and give up the link's underline and inherited colour. */
a.primary {
  text-align: center;
  text-decoration: none;
  color: #fff;
  display: block;
}
</style>
