import type { AuthUser } from '@kachnadocs/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, setToken } from '../api';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function loginWithHandle(handle: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await api<{ token: string; user: AuthUser }>('/auth/dev-login', {
        method: 'POST',
        body: JSON.stringify({ handle }),
      });
      setToken(res.token);
      user.value = res.user;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Přihlášení selhalo.';
      user.value = null;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Restore a session on load; a stale token just means "not signed in".
   *
   * Runs the OAuth handoff first: Discord's callback redirected us to `#token=…`
   * (see backend/src/auth/auth.controller.ts). The fragment must be removed from
   * the history as soon as it is read, otherwise the credential sits in the
   * address bar and in every later `history` entry of the session.
   */
  async function restore(): Promise<void> {
    adoptTokenFromUrl();
    reportUrlError();
    try {
      user.value = await api<AuthUser>('/auth/me');
    } catch {
      user.value = null;
    }
  }

  function adoptTokenFromUrl(): void {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = hash.get('token');
    if (!token) return;
    setToken(token);
    // replaceState, not push: the URL holding the token must not be reachable
    // again with the Back button.
    history.replaceState(null, '', location.pathname + location.search);
  }

  /** Surface a failed OAuth handoff instead of silently showing the login form. */
  function reportUrlError(): void {
    const reason = new URLSearchParams(location.search).get('auth_error');
    if (!reason) return;
    error.value =
      reason === 'denied'
        ? 'Přihlášení přes Discord bylo zrušeno.'
        : 'Relaci se nepodařilo vytvořit — zkuste to znovu.';
    history.replaceState(null, '', location.pathname);
  }

  function logout(): void {
    setToken(null);
    user.value = null;
  }

  return { user, loading, error, loginWithHandle, restore, logout };
});
