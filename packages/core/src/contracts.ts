import { z } from 'zod';
import type { Blocked, Command, Task } from './lifecycle';

/*
 * What each agent role must return. Agent output is untrusted: it is validated here, and anything
 * that decides risk (changed paths, diff size, head commit) comes from the engine's own reading of
 * GitHub, never from the agent's claims.
 */

const text = z.string().trim().min(1);

const askedOfSchema = z.enum(['requester', 'maintainer', 'owner']);

const blockedSchema = z.strictObject({
  outcome: z.literal('blocked'),
  question: text,
  askedOf: askedOfSchema.default('maintainer')
});

export const interviewerOutputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('question'), question: text.max(1500) }),
  z.strictObject({
    outcome: z.literal('complete'),
    title: text.max(120),
    summary: text.max(4000),
    acceptance: z.array(text.max(500)).min(1).max(10)
  })
]);

export const specOutputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('specced'),
    spec: text,
    predictedPaths: z.array(text).min(1),
    userVisible: z.boolean()
  }),
  blockedSchema
]);

export const builderOutputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('pushed'),
    branch: text.regex(/^officina\//, 'branch must start with officina/'),
    /** The pull request title, in the repository's required format. */
    prTitle: text.max(120),
    verified: z.array(text),
    notVerified: z.array(text)
  }),
  z.strictObject({ outcome: z.literal('failed'), why: text }),
  blockedSchema
]);

/**
 * The onboarder pushes the agent docs like a builder pushes code, and also hands back the worst
 * smells it found (duplicates, god files, misplaced code) as follow-ups for the pull request body.
 */
export const onboarderOutputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('pushed'),
    branch: text.regex(/^officina\//, 'branch must start with officina/'),
    prTitle: text.max(120),
    verified: z.array(text),
    notVerified: z.array(text),
    followUps: z.array(text.max(500)).max(15)
  }),
  z.strictObject({ outcome: z.literal('failed'), why: text }),
  blockedSchema
]);

export const reviewerOutputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('approve'), summary: text }),
  z.strictObject({
    outcome: z.literal('changes'),
    items: z
      .array(
        z.strictObject({
          file: text,
          line: z.number().int().positive().optional(),
          issue: text
        })
      )
      .min(1)
  })
]);

const extraApprovalSchema = z.union([
  z.strictObject({
    domain: text.regex(/^[a-z][a-z0-9-]*$/, 'a lowercase domain name'),
    reason: text
  }),
  z.strictObject({ role: z.enum(['maintainer', 'owner']), reason: text })
]);

/**
 * The approval chooser runs at each human gate. At spec review it plans who approves the spec; at
 * verification it also writes the checklist. It can add approvals and name verifiers, never remove.
 */
export const chooserOutputSchema = z.strictObject({
  userVisible: z.boolean(),
  approval: z.strictObject({
    depth: z.enum(['glance', 'test', 'device']),
    rationale: text.max(600),
    extraApprovals: z.array(extraApprovalSchema).max(4).default([]),
    verifiers: z
      .array(z.strictObject({ memberId: z.uuid(), reason: text.max(300) }))
      .max(3)
      .default([])
  }),
  /** Required at verification, where the engine checks it is not empty. */
  checklist: z.array(text).default([]),
  beforeAfter: z
    .array(z.strictObject({ key: text, locale: text, before: z.string(), after: z.string() }))
    .default([])
});

/**
 * Where a learning's edit goes: the project's agent docs (its entry document and the pages of its
 * `docs.standards` folder), another Markdown doc of the project, or an Officina role prompt
 * (`agents/<role>.md`).
 */
export const LEARNING_TARGETS = ['docs', 'project', 'agent'] as const;
export type LearningTarget = (typeof LEARNING_TARGETS)[number];

/** Edits to the project land in its repository as a pull request; agent edits stay with Officina. */
export const editsProject = (target: LearningTarget): boolean => target !== 'agent';

/**
 * A learning is a lesson from one finished task plus the exact edit that would make it stick: an
 * addition to the project's docs, or to an Officina agent prompt. People accept or reject it.
 */
export const learnerOutputSchema = z.strictObject({
  learnings: z
    .array(
      z.strictObject({
        title: text.max(100),
        lesson: text.max(1500),
        /** What in this task's history shows it: rounds, questions, overrides, time, cost. */
        evidence: text.max(2000),
        target: z.enum(LEARNING_TARGETS),
        edit: z.strictObject({
          file: text.max(300),
          /** Exact text to replace, found once in the file; without it the text is appended. */
          find: z.string().min(1).max(3000).optional(),
          text: text.max(4000)
        })
      })
    )
    .max(3)
});

export const OUTPUT_SCHEMAS = {
  interviewer: interviewerOutputSchema,
  spec: specOutputSchema,
  builder: builderOutputSchema,
  reviewer_spec: reviewerOutputSchema,
  reviewer_correctness: reviewerOutputSchema,
  chooser: chooserOutputSchema,
  learner: learnerOutputSchema,
  onboarder: onboarderOutputSchema
} as const;

export type ContractRole = keyof typeof OUTPUT_SCHEMAS;
export type AgentOutput<R extends ContractRole> = z.infer<(typeof OUTPUT_SCHEMAS)[R]>;

export type OutputResult<R extends ContractRole> =
  | { readonly ok: true; readonly output: AgentOutput<R> }
  | { readonly ok: false; readonly errors: readonly string[] };

export const parseAgentOutput = <R extends ContractRole>(
  role: R,
  raw: unknown
): OutputResult<R> => {
  const parsed = OUTPUT_SCHEMAS[role].safeParse(raw);
  if (parsed.success) {
    return { ok: true, output: parsed.data as AgentOutput<R> };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    )
  };
};

/** Facts the engine establishes itself after a builder reports a push. */
export interface PushFacts {
  readonly headSha: string;
  readonly changedPaths: readonly string[];
  readonly diffLines: number;
}

const blockCommand = (
  task: Task,
  question: string,
  askedOf: z.infer<typeof askedOfSchema>
): Command => {
  const target: Blocked['askedOf'] =
    askedOf === 'requester' ? { memberId: task.requesterId } : { role: askedOf };
  return { type: 'block', question, askedOf: target };
};

export type RoleOutput =
  | { readonly role: 'interviewer'; readonly output: AgentOutput<'interviewer'> }
  | { readonly role: 'spec'; readonly output: AgentOutput<'spec'> }
  | {
      readonly role: 'builder';
      readonly output: AgentOutput<'builder'>;
      readonly facts?: PushFacts;
    }
  | {
      readonly role: 'onboarder';
      readonly output: AgentOutput<'onboarder'>;
      readonly facts?: PushFacts;
    }
  | {
      readonly role: 'reviewer_spec' | 'reviewer_correctness';
      readonly output: AgentOutput<'reviewer_spec'>;
    }
  | { readonly role: 'chooser'; readonly output: AgentOutput<'chooser'> };

export type CommandResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly error: 'missing_push_facts' };

/** Translates a validated agent output into the lifecycle command the engine applies for it. */
export const commandForOutput = (task: Task, result: RoleOutput): CommandResult => {
  switch (result.role) {
    case 'interviewer': {
      const output = result.output;
      if (output.outcome === 'question') {
        return { ok: true, command: blockCommand(task, output.question, 'requester') };
      }
      return { ok: true, command: { type: 'submit_request' } };
    }
    case 'spec': {
      const output = result.output;
      if (output.outcome === 'blocked') {
        return { ok: true, command: blockCommand(task, output.question, output.askedOf) };
      }
      return {
        ok: true,
        command: {
          type: 'post_spec',
          predictedPaths: output.predictedPaths,
          userVisible: output.userVisible
        }
      };
    }
    case 'builder':
    case 'onboarder': {
      const output = result.output;
      if (output.outcome === 'blocked') {
        return { ok: true, command: blockCommand(task, output.question, output.askedOf) };
      }
      if (output.outcome === 'failed') {
        return {
          ok: true,
          command: blockCommand(task, `The build failed: ${output.why}`, 'maintainer')
        };
      }
      if (result.facts === undefined) return { ok: false, error: 'missing_push_facts' };
      return { ok: true, command: { type: 'push', ...result.facts } };
    }
    case 'reviewer_spec':
    case 'reviewer_correctness': {
      const output = result.output;
      if (output.outcome === 'approve') {
        return { ok: true, command: { type: 'review', verdict: 'approve', notes: output.summary } };
      }
      const notes = output.items
        .map(
          (item, index) =>
            `${index + 1}. ${item.file}${item.line ? `:${item.line}` : ''} ${item.issue}`
        )
        .join('\n');
      return { ok: true, command: { type: 'review', verdict: 'changes', notes } };
    }
    case 'chooser': {
      const { approval, userVisible } = result.output;
      const plan = {
        depth: approval.depth,
        rationale: approval.rationale,
        extra: approval.extraApprovals.map(({ reason, ...requirement }) => ({
          requirement,
          reason
        })),
        verifiers: approval.verifiers
      };
      return {
        ok: true,
        command: {
          type: task.stage === 'spec_review' ? 'plan_approval' : 'choose',
          userVisible,
          plan
        }
      };
    }
  }
};
