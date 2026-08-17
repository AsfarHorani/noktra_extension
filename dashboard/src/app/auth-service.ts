// Mirrors popup.js's login/signup/logout flow — the dashboard is a
// separate extension page but reads the same chrome.storage.local
// "authToken" key, so logging in once via either the popup or the
// dashboard carries over to the other automatically.
import { Injectable, signal } from '@angular/core';
import { apiFetch, clearAuthToken, getAuthToken, setAuthToken } from './api-client';

interface AuthResponse {
  token: string;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  // null while checkAuth() hasn't resolved yet, false once confirmed no
  // token, true once confirmed logged in — app.ts uses the tri-state to
  // avoid flashing the login screen for a moment before the initial check
  // completes.
  readonly isLoggedIn = signal<boolean | null>(null);

  async checkAuth(): Promise<void> {
    const token = await getAuthToken();
    this.isLoggedIn.set(!!token);
  }

  async login(email: string, password: string): Promise<void> {
    const data = await apiFetch<AuthResponse>('/auth/login/', { method: 'POST', body: JSON.stringify({ email, password }) });
    await setAuthToken(data.token);
    this.isLoggedIn.set(true);
  }

  async signup(email: string, password: string): Promise<void> {
    const data = await apiFetch<AuthResponse>('/auth/signup/', { method: 'POST', body: JSON.stringify({ email, password }) });
    await setAuthToken(data.token);
    this.isLoggedIn.set(true);
  }

  async logout(): Promise<void> {
    try {
      await apiFetch('/auth/logout/', { method: 'POST' });
    } catch {
      // Swallowed deliberately — try/finally with no catch still re-throws
      // after finally runs, which would surface as an unhandled rejection
      // whenever the server call fails (e.g. server not running). The
      // isLoggedIn signal write below already happens regardless (that's
      // the actual point of the finally), so the caller doesn't need to
      // know the server-side half failed.
    } finally {
      await clearAuthToken();
      this.isLoggedIn.set(false);
    }
  }
}
