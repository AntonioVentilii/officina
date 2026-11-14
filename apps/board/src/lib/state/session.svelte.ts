import { ApiError, get, post } from '$lib/api';
import type { Me, Permission, Project } from '$lib/types';
import { toasts } from './toasts.svelte';

const PROJECT_KEY = 'officina.project';

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the choice then lasts for this visit only.
  }
};

class Session {
  me = $state<Me | null>(null);
  status = $state<'loading' | 'signed-out' | 'ready' | 'error'>('loading');
  error = $state<string | null>(null);
  projectId = $state<string | null>(null);

  project = $derived<Project | null>(
    this.me?.projects.find((project) => project.id === this.projectId) ?? null
  );

  /** Whether the member may take an action in the selected project, as the API decided. */
  can(action: Permission): boolean {
    return this.project?.can.includes(action) ?? false;
  }

  /** Who sees costs, commits and agent runs; everyone else sees the essentials. */
  technical = $derived(this.project?.can.includes('see_runs') ?? false);

  async load() {
    try {
      const me = await get<Me>('/api/me');
      this.me = me;
      const preferred = stored(PROJECT_KEY);
      this.projectId =
        me.projects.find((project) => project.id === preferred)?.id ?? me.projects[0]?.id ?? null;
      this.status = 'ready';
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.status = 'signed-out';
      } else {
        this.status = 'error';
        this.error = (error as Error).message;
      }
    }
  }

  selectProject(id: string) {
    this.projectId = id;
    store(PROJECT_KEY, id);
  }

  /** Connecting GitHub is a write, so it starts from a request this page sends, never a plain link. */
  async connectGitHub() {
    try {
      const { redirect } = await post<{ redirect: string }>('/auth/github/link');
      location.assign(redirect);
    } catch (error) {
      toasts.show('error', (error as Error).message);
    }
  }

  async disconnectGitHub() {
    try {
      await post('/auth/github/unlink');
      await this.load();
    } catch (error) {
      toasts.show('error', (error as Error).message);
    }
  }

  async signOut() {
    await post('/auth/sign-out');
    this.me = null;
    this.status = 'signed-out';
  }
}

export const session = new Session();
