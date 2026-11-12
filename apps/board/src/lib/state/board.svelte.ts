import { get } from '$lib/api';
import { isActive } from '$lib/runs';
import type { AgentRoleInfo, Card, Learning, Run } from '$lib/types';
import { coalesce, live } from './live.svelte';
import { session } from './session.svelte';

class Board {
  tasks = $state<Card[]>([]);
  runs = $state<Run[]>([]);
  agents = $state<AgentRoleInfo[]>([]);
  roleLabels = $state<Record<string, string>>({});
  learnings = $state<Learning[]>([]);
  loaded = $state(false);
  #projectId: string | null = null;
  #unsubscribe: (() => void) | null = null;

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
    this.roleLabels = {};
    this.learnings = [];
    this.loaded = false;
    this.#unsubscribe?.();
    this.#unsubscribe = live.subscribe((event) => {
      if (event.projectId === '*' || event.projectId === this.#projectId) this.#refreshSoon();
    });
    void this.refresh();
  }

  async refresh() {
    const projectId = this.#projectId;
    if (!projectId) return;
    // Runs and learnings are for maintainers and owners; the API refuses them to anyone else.
    const technical = session.technical;
    const [board, runs, learnings] = await Promise.all([
      get<{ tasks: Card[]; roleLabels: Record<string, string> }>(
        `/api/projects/${projectId}/board`
      ),
      technical
        ? get<{ runs: Run[]; agents: AgentRoleInfo[] }>(`/api/projects/${projectId}/runs`)
        : { runs: [], agents: [] },
      technical
        ? get<{ learnings: Learning[] }>(`/api/projects/${projectId}/learnings`)
        : { learnings: [] }
    ]);
    if (projectId !== this.#projectId) return;
    this.tasks = board.tasks;
    this.roleLabels = board.roleLabels;
    this.runs = runs.runs;
    this.agents = runs.agents;
    this.learnings = learnings.learnings;
    this.loaded = true;
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
