import { ApiError, get, post } from '$lib/api';
import { latestOnly } from '$lib/latest';
import { isActive } from '$lib/runs';
import type { AgentRoleInfo, Card, Learning, MemberActivity, Notice, Run } from '$lib/types';
import { coalesce, live } from './live.svelte';
import { session } from './session.svelte';

class Board {
  tasks = $state<Card[]>([]);
  runs = $state<Run[]>([]);
  agents = $state<AgentRoleInfo[]>([]);
  /** What the runs listed cost in all, as the API added it up. */
  runsCostCents = $state(0);
  roleLabels = $state<Record<string, string>>({});
  learnings = $state<Learning[]>([]);
  members = $state<MemberActivity[]>([]);
  notices = $state<Notice[]>([]);
  loaded = $state(false);
  /** Why the last load failed; cleared by the next one that succeeds. */
  error = $state<string | null>(null);
  #projectId: string | null = null;
  #unsubscribe: (() => void) | null = null;
  // Refreshes can overlap; only the latest one may set what the board shows.
  #latest = latestOnly();

  waitingOnMe = $derived(this.tasks.filter((task) => task.waitingOn.me));
  proposedLearnings = $derived(this.learnings.filter((item) => item.status === 'proposed'));
  running = $derived(this.runs.filter(isActive));

  #refreshSoon = coalesce(() => void this.refresh(), 250);

  start(projectId: string) {
    if (this.#projectId === projectId) return;
    this.#projectId = projectId;
    this.tasks = [];
    this.runs = [];
    this.agents = [];
    this.runsCostCents = 0;
    this.roleLabels = {};
    this.learnings = [];
    this.members = [];
    this.notices = [];
    this.loaded = false;
    this.error = null;
    this.#unsubscribe?.();
    this.#unsubscribe = live.subscribe((event) => {
      if (event.projectId === '*' || event.projectId === this.#projectId) this.#refreshSoon();
    });
    void this.refresh();
  }

  async refresh() {
    const projectId = this.#projectId;
    if (!projectId) return;
    const newer = this.#latest();
    const stale = () => newer() || projectId !== this.#projectId;
    // Runs, learnings and members are for maintainers and owners; the API refuses them to anyone else.
    const technical = session.technical;
    try {
      const [board, runs, learnings, members, notices] = await Promise.all([
        get<{ tasks: Card[]; roleLabels: Record<string, string> }>(
          `/api/projects/${projectId}/board`
        ),
        technical
          ? get<{ runs: Run[]; agents: AgentRoleInfo[]; costCents: number }>(
              `/api/projects/${projectId}/runs`
            )
          : { runs: [], agents: [], costCents: 0 },
        technical
          ? get<{ learnings: Learning[] }>(`/api/projects/${projectId}/learnings`)
          : { learnings: [] },
        technical
          ? get<{ members: MemberActivity[] }>(`/api/projects/${projectId}/members`)
          : { members: [] },
        get<{ notifications: Notice[] }>(`/api/projects/${projectId}/notifications`)
      ]);
      if (stale()) return;
      this.tasks = board.tasks;
      this.roleLabels = board.roleLabels;
      this.runs = runs.runs;
      this.agents = runs.agents;
      this.runsCostCents = runs.costCents;
      this.learnings = learnings.learnings;
      this.members = members.members;
      this.notices = notices.notifications;
      this.error = null;
      this.loaded = true;
    } catch (error) {
      if (stale()) return;
      // An expired session sends the person to sign in; anything else is shown with a retry.
      if (error instanceof ApiError && error.status === 401) session.status = 'signed-out';
      else this.error = (error as Error).message;
    }
  }

  /** Marks a notification read; it leaves the Inbox at once. */
  async dismiss(id: string) {
    await post(`/api/notifications/${id}/read`);
    this.notices = this.notices.filter((notice) => notice.id !== id);
  }

  /** An agent role's name as the API gives it, or the role itself until the board has loaded. */
  roleLabel(role: string): string {
    return this.roleLabels[role] ?? role;
  }

  get projectId() {
    return this.#projectId ?? session.projectId;
  }
}

export const board = new Board();
