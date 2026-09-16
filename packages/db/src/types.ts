import type { Task } from '@officina/core';

export type { Actor } from '@officina/core';

export interface StoredTaskContext {
  readonly task: Task;
  readonly version: number;
  readonly number: number;
  readonly title: string;
  readonly projectId: string;
  readonly repo: string;
  readonly installationId: number | null;
  readonly defaultBranch: string;
  readonly rawConfig: unknown;
  readonly pullRequest: number | null;
  readonly issue: number | null;
  readonly latestSpec: string | null;
}
