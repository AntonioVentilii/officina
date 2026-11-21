import { z } from 'zod';
import type { Command } from './lifecycle';
import { SPEC_BODY_MAX } from './limits';

/*
 * A request too large or too mixed for one change comes back from the spec agent as a proposed
 * split: ordered sub-tasks people decide on before any is opened. It is agent-written, so it is
 * validated here; the descriptions reach the agent in the `submit_result` schema.
 */

const text = z.string().trim().min(1);

/** The most sub-tasks one proposal may hold. */
const MAX_SUBTASKS = 12;

const proposedSubtaskSchema = z.strictObject({
  title: text.max(120).describe('What the sub-task delivers, as a task title.'),
  scope: text
    .max(2000)
    .describe(
      'What this sub-task covers and what it leaves to the others, in a few sentences: one purpose that a builder can implement and a reviewer verify on its own.'
    ),
  paths: z
    .array(text.max(300))
    .min(1)
    .max(100)
    .describe(
      'The files it will roughly touch, tests included. Its own spec lists them exactly later.'
    ),
  after: z
    .array(z.number().int().positive())
    .max(MAX_SUBTASKS)
    .default([])
    .describe(
      'The positions in this list (1 is the first) of the sub-tasks that must merge before this one is built. Only earlier positions: the list is in dependency order.'
    )
});

export type ProposedSubtask = z.infer<typeof proposedSubtaskSchema>;

/** The shape people decided the next spec must take: a proposed split, or one spec. */
export type SpecShape = 'split' | 'whole';

/** What a proposal holds besides its outcome: why, and the sub-tasks in order. */
export interface ProposedSplit {
  readonly why: string;
  readonly subtasks: readonly ProposedSubtask[];
}

/** Every sub-task waits only for sub-tasks listed before it, so the order holds and has no cycle. */
const waitsOnlyForEarlier = (subtasks: readonly ProposedSubtask[]): boolean =>
  subtasks.every((subtask, index) => subtask.after.every((position) => position <= index));

export const splitOutputSchema = z
  .strictObject({
    outcome: z.literal('split'),
    why: text
      .max(2000)
      .describe(
        "Why one spec would not do: the separate purposes the request holds, or the size you estimate for it against the lane's limit."
      ),
    subtasks: z
      .array(proposedSubtaskSchema)
      .min(2)
      .max(MAX_SUBTASKS)
      .refine(waitsOnlyForEarlier, 'a sub-task may only wait for sub-tasks listed before it')
      .describe(
        'The sub-tasks in dependency order, from the one the others need to the last; sub-tasks that touch the same files follow one another.'
      ),
    userVisible: z.boolean()
  })
  .refine((split) => splitMarkdown(split).length <= SPEC_BODY_MAX, {
    message: `the proposal must read in at most ${SPEC_BODY_MAX} characters, like a spec: fewer files or shorter scopes`
  });

type SplitOutput = z.infer<typeof splitOutputSchema>;

/** Every file the sub-tasks touch, once each: what the lane and the guards of the whole read. */
export const splitPaths = (split: ProposedSplit): string[] =>
  [...new Set(split.subtasks.flatMap((subtask) => subtask.paths))].sort();

const subtaskMarkdown = (subtask: ProposedSubtask, index: number): string =>
  [
    `${index + 1}. **${subtask.title}**: ${subtask.scope.replace(/\s*\n\s*/g, ' ')}`,
    `    - Files: ${subtask.paths.map((path) => `\`${path}\``).join(', ')}`,
    subtask.after.length ? `    - After: ${subtask.after.join(', ')}` : null
  ]
    .filter(Boolean)
    .join('\n');

/**
 * The proposal as people read it, stored as the body of its spec version, so every place that
 * shows a plan shows it as it is.
 */
export const splitMarkdown = (split: ProposedSplit): string =>
  [
    `**Proposed split into ${split.subtasks.length} sub-tasks.** ${split.why}`,
    split.subtasks.map(subtaskMarkdown).join('\n')
  ].join('\n\n');

/**
 * The command a spec is posted with, or a proposed split, which is posted like one with every file
 * its sub-tasks touch and the mark that keeps it from being approved as a spec.
 */
export const postSpecCommand = (
  output:
    SplitOutput | { readonly predictedPaths: readonly string[]; readonly userVisible: boolean }
): Command =>
  'subtasks' in output
    ? {
        type: 'post_spec',
        predictedPaths: splitPaths(output),
        userVisible: output.userVisible,
        split: true
      }
    : { type: 'post_spec', predictedPaths: output.predictedPaths, userVisible: output.userVisible };
