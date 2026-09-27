import { get } from '$lib/api';
import type { Card, Run } from '$lib/types';
import { coalesce, live } from './live.svelte';
import { session } from './session.svelte';

class Board {
  tasks = $state<Card[]>([]);
  runs = $state<Run[]>([]);
  loaded = $state(false);
  #projectId: string | null = null;
  #unsubscribe: (() => void) | null = null;

  waitingOnMe = $derived(this.tasks.filter((task) => task.waitingOn.me));
  running = $derived(
    this.runs.filter((run) => run.status === 'running' || run.status === 'queued')
  );

  #refreshSoon = coalesce(() => void this.refresh(), 250);

  start(projectId: string) {
    if (this.#projectId === projectId) return;
    this.#projectId = projectId;
    this.tasks = [];
    this.runs = [];
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
    const [board, runs] = await Promise.all([
      get<{ tasks: Card[] }>(`/api/projects/${projectId}/board`),
      get<{ runs: Run[] }>(`/api/projects/${projectId}/runs`)
    ]);
    if (projectId !== this.#projectId) return;
    this.tasks = board.tasks;
    this.runs = runs.runs;
    this.loaded = true;
  }

  get projectId() {
    return this.#projectId ?? session.projectId;
  }
}

export const board = new Board();
