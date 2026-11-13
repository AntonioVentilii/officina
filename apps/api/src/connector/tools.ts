import {
  ACTION_LABELS,
  TERMINAL_STAGES,
  allowedActions,
  taskUrl,
  type Preview
} from '@officina/core';
import type { MemberProject } from '@officina/db';
import type { Pool } from 'pg';
import { z } from 'zod';
import { boardView, taskView, type BoardViewer, type CardView, type TaskView } from '../board';
import { TaskCommandError, actOnTaskAs, commentAs, createRequestAs } from '../tasks';

/**
 * The connector's tools. Each one is a thin call into what the board's API already does
 * (`createRequestAs`, `actOnTaskAs`, `boardView`, `taskView`), as the member the token belongs to,
 * with the same permissions. Descriptions are written for Claude talking to someone who is not a
 * developer: what to ask them first, and what a good request looks like.
 */

export interface ToolContext {
  readonly pool: Pool;
  readonly publicUrl: string;
  readonly memberId: string;
  readonly workspaceId: string;
  readonly projects: readonly MemberProject[];
}

/** A failure Claude should explain to the person, not a protocol error. */
export class ToolError extends Error {}

const PROJECT = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'The project by name or repository (for example "web-app" or "acme/web-app"). Leave it out when the person belongs to one project; otherwise call list_projects and ask which one.'
  );
const NUMBER = z.number().int().min(1).describe('The task number, as in "task 12".');

const viewerFor = (context: ToolContext, project: MemberProject): BoardViewer => ({
  memberId: context.memberId,
  workspaceId: context.workspaceId,
  projectId: project.id,
  role: project.role,
  domains: project.domains
});

const projectFor = (context: ToolContext, wanted: string | undefined): MemberProject => {
  if (context.projects.length === 0)
    throw new ToolError(
      'You are not a member of any project yet. Ask an Officina owner to add you.'
    );
  if (!wanted) {
    if (context.projects.length === 1) return context.projects[0]!;
    throw new ToolError(
      `You belong to several projects: ${context.projects.map((project) => project.name).join(', ')}. Say which one.`
    );
  }
  const key = wanted.toLowerCase();
  const found = context.projects.find(
    (project) =>
      project.name.toLowerCase() === key ||
      project.repo.toLowerCase() === key ||
      project.repo.toLowerCase().endsWith(`/${key}`) ||
      project.id === wanted
  );
  if (!found)
    throw new ToolError(
      `No project called "${wanted}". Yours: ${context.projects.map((project) => project.name).join(', ')}.`
    );
  return found;
};

/** What a role may do, in the permission matrix's own words. */
const roleCan = (role: MemberProject['role']) =>
  allowedActions(role)
    .map((action) => ACTION_LABELS[action])
    .join('; ');

const cardLine = (context: ToolContext, project: MemberProject, card: CardView) =>
  `- Task ${card.number}: ${card.title}, requested by ${card.requester}. Now: ${card.waitingOn.label}. ${taskUrl(context.publicUrl, project.id, card.number)}`;

type TaskDetail = NonNullable<Awaited<ReturnType<typeof taskView>>>;

/** Who asked, who approves each gate and who merges, so nobody assumes the requester decides. */
const peopleLines = ({ people }: TaskDetail) => [
  ...people.gates.map(
    (gate) =>
      `${gate.does}: ${gate.requirements
        .map(
          (requirement) =>
            `${requirement.label} (${requirement.waived ? 'nobody holds it, so it is waived' : requirement.who.join(', ') || 'nobody yet'}${requirement.approvedBy.length ? `; approved by ${requirement.approvedBy.join(', ')}` : ''})`
        )
        .join(', ')}.${gate.asked.length ? ` Asked to check: ${gate.asked.join(', ')}.` : ''}`
  ),
  people.merge.by === 'auto'
    ? 'Merge: GitHub merges it once its checks pass.'
    : `Merge: a person merges it on GitHub (${people.merge.who.join(', ') || 'nobody yet'}).`
];

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n\n(cut here; the full text is on the board)` : text;

/** A preview as Claude can show it in chat: words side by side, a mock to render, or a link. */
const previewText = (preview: Preview): string => {
  switch (preview.kind) {
    case 'text':
      return `Wording now: "${preview.before}"\n   Wording after: "${preview.after}"`;
    case 'markdown':
      return `Example (Markdown):\n${preview.body}`;
    case 'html':
      return `Mock (agent-written HTML; show it rendered as a static picture, never run scripts in it):\n\`\`\`html\n${preview.body}\n\`\`\``;
    case 'link':
      return `See it: ${preview.url}${preview.label ? ` (${preview.label})` : ''}`;
  }
};

const questionLines = (blocked: NonNullable<TaskView['blocked']>): string[] => {
  const lines = ['', `Open question for ${blocked.askedOf}:`, blocked.question];
  if (!blocked.options.length) return lines;
  lines.push(
    '',
    'Options (show each preview to the person before they choose; they may also answer in their own words):'
  );
  for (const option of blocked.options) {
    lines.push(`(${option.key}) ${option.label}${option.detail ? `: ${option.detail}` : ''}`);
    if (option.preview) lines.push(`   ${previewText(option.preview)}`);
  }
  return lines;
};

const WHAT_TO_DO: Record<string, string> = {
  answer: 'answer the open question (answer_question)',
  approve: 'approve, after reading what to check (review with decision "approve")',
  changes: 'ask for changes, saying what is wrong (review with decision "changes")',
  comment: 'add a comment (comment)',
  accept: 'accept or decline it on the board',
  submit: 'send it on as it is, on the board',
  cancel: 'cancel it on the board'
};

interface Tool<T extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: T;
  readonly readOnly: boolean;
  run(context: ToolContext, input: z.infer<T>): Promise<string>;
}

type Outcome = { readonly text: string; readonly isError: boolean };

/** A tool whose `call` checks the raw arguments against its own schema before running it. */
const tool = <T extends z.ZodType>(definition: Tool<T>) => ({
  ...definition,
  call: async (context: ToolContext, args: unknown): Promise<Outcome> => {
    const parsed = definition.input.safeParse(args ?? {});
    if (!parsed.success)
      return {
        text: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; '),
        isError: true
      };
    return { text: await definition.run(context, parsed.data), isError: false };
  }
});

export const TOOLS = [
  tool({
    name: 'list_projects',
    title: 'List my Officina projects',
    description:
      'Lists the projects the person can work on in Officina (the software workshop where agents build what people ask for), with their role in each. Call it first when you do not know which project a request belongs to.',
    input: z.object({}),
    readOnly: true,
    run: async (context) =>
      context.projects.length
        ? context.projects
            .map(
              (project) =>
                `- ${project.name} (${project.repo}): your role is ${project.role}, so you can ${roleCan(project.role)}.`
            )
            .join('\n')
        : 'You are not a member of any project yet. Ask an Officina owner to add you.'
  }),
  tool({
    name: 'open_request',
    title: 'Open a request',
    description: `Opens a new request in Officina: something to change, fix or add in a product. Agents then ask follow-up questions, write a plan for people to approve, build it and review it; people check the result before it ships.

Before calling, make sure you know, in the person's own words:
- what they want to be different, and where (which screen, page, email or message);
- why, or what problem it solves;
- what must stay as it is;
- for a bug: what they did, what they expected, what happened instead.
Ask for what is missing, one short question at a time, then write the request in plain language. Do not invent technical details or file names.

Examples:
- Change a text: title "Rename the Submit button to Send", request "On the contact form the button says Submit. It should say Send, in every language. Nothing else on the form changes."
- Report a bug: title "Profile photo does not save", request "I pick a new photo in Settings > Profile and press Save. The old photo is still there after reloading. Expected: the new photo stays."
- Ask for a feature: title "Remind people of unfinished orders", request "People forget orders they started. Send a reminder the next morning if one is unfinished. Only once per order."

After it is opened, tell the person the task link and that an agent may ask them questions there or here (whats_waiting_on_me).`,
    input: z.object({
      project: PROJECT,
      title: z
        .string()
        .trim()
        .min(3)
        .max(200)
        .describe('A short imperative title, for example "Rename the Submit button to Send".'),
      request: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .describe('What the person wants, why, and what must not change, in plain language.'),
      skip_interview: z
        .boolean()
        .optional()
        .describe(
          'Only when the person explicitly says the request is complete and needs no questions.'
        )
    }),
    readOnly: false,
    run: async (context, input) => {
      const project = projectFor(context, input.project);
      const created = await createRequestAs(context.pool, {
        projectId: project.id,
        memberId: context.memberId,
        title: input.title,
        request: input.request,
        skipInterview: input.skip_interview === true
      });
      const next =
        created.stage === 'request'
          ? 'An agent reads it now and may ask a few questions; they show up in whats_waiting_on_me and on the board.'
          : 'It waits for a maintainer to accept it; then an agent writes the plan.';
      return `Opened task ${created.number} in ${project.name}: ${taskUrl(context.publicUrl, project.id, created.number)}\n${next}`;
    }
  }),
  tool({
    name: 'whats_waiting_on_me',
    title: 'What is waiting on me',
    description:
      'Lists every task where it is the person\'s turn: questions from agents to answer, plans to approve, results to check, and merges. This is the yellow "waiting on you" block on the board. Call it when the person asks what they need to do, or after a while to see if an agent asked something.',
    input: z.object({
      project: PROJECT.describe('Only this project; leave it out to look at all of them.')
    }),
    readOnly: true,
    run: async (context, input) => {
      const projects = input.project ? [projectFor(context, input.project)] : context.projects;
      const sections: string[] = [];
      for (const project of projects) {
        const mine = (await boardView(context.pool, viewerFor(context, project))).filter(
          (card) => card.waitingOn.me
        );
        if (mine.length)
          sections.push(
            `${project.name}:\n${mine.map((card) => cardLine(context, project, card)).join('\n')}`
          );
      }
      return sections.length
        ? `${sections.join('\n\n')}\n\nUse show_task to see what each one needs, with the options and previews of any question.`
        : 'Nothing is waiting on you. Agents keep working; new questions and checks appear here.';
    }
  }),
  tool({
    name: 'list_tasks',
    title: 'List the tasks in progress',
    description:
      "Lists every task in progress in a project, whoever asked for it: its number, title, who requested it and what it waits for now. Every member of a project sees all of its work. Use it when the person asks what the team is working on or how something is going; use whats_waiting_on_me for what needs them, and show_task for one task's detail.",
    input: z.object({ project: PROJECT }),
    readOnly: true,
    run: async (context, input) => {
      const project = projectFor(context, input.project);
      const open = (await boardView(context.pool, viewerFor(context, project))).filter(
        (card) => !TERMINAL_STAGES.has(card.stage)
      );
      return open.length
        ? `${project.name}, ${open.length} in progress:\n${open.map((card) => cardLine(context, project, card)).join('\n')}`
        : `Nothing is in progress in ${project.name}. Open a request with open_request.`;
    }
  }),
  tool({
    name: 'show_task',
    title: 'Show a task',
    description:
      'Shows one task: where it is, whose turn it is, the request, any open question with the options it offers and a preview of each, the plan, what to check and the conversation. Use it before answering, approving or asking for changes, and summarise it for the person in plain words. When a question offers options, show the person what each one would look like (the wording side by side, the example or mock rendered as a visual, the link) before they choose.',
    input: z.object({ project: PROJECT, number: NUMBER }),
    readOnly: true,
    run: async (context, input) => {
      const project = projectFor(context, input.project);
      const task = await taskView(context.pool, viewerFor(context, project), input.number);
      if (!task) throw new ToolError(`There is no task ${input.number} in ${project.name}.`);
      const lines = [
        `Task ${task.number} in ${project.name}: ${task.title}`,
        `Link: ${taskUrl(context.publicUrl, project.id, task.number)}`,
        `Requested by ${task.requester}. Now: ${task.waitingOn.label}${task.waitingOn.me ? ' (your turn)' : ''}.`,
        ...peopleLines(task)
      ];
      if (task.pullRequestUrl) lines.push(`Pull request: ${task.pullRequestUrl}`);
      if (task.blocked) lines.push(...questionLines(task.blocked));
      if (task.request) lines.push('', `Request (${task.request.author}):`, task.request.body);
      const spec = task.specs.at(-1);
      if (spec) lines.push('', `Plan, version ${spec.version}:`, truncate(spec.body, 8_000));
      if (task.approval?.pending.length)
        lines.push('', `Still needs approval from: ${task.approval.pending.join(', ')}.`);
      if (task.plan?.current) lines.push(`How deep to check: ${task.plan.depthLabel}.`);
      if (task.stage === 'verifying' && task.checklist?.checklist.length) {
        lines.push('', 'What to check:', ...task.checklist.checklist.map((item) => `- ${item}`));
        for (const row of task.checklist.beforeAfter ?? [])
          lines.push(`- ${row.key} (${row.locale}): "${row.before}" becomes "${row.after}"`);
      }
      if (task.comments.length) {
        lines.push('', 'Conversation:');
        for (const comment of task.comments.slice(-20))
          lines.push(`- ${comment.author}: ${truncate(comment.body, 1_500)}`);
      }
      const actions = task.actions.map((action) => WHAT_TO_DO[action]).filter(Boolean);
      if (actions.length) lines.push('', `You can: ${actions.join('; ')}.`);
      return lines.join('\n');
    }
  }),
  tool({
    name: 'answer_question',
    title: 'Answer a question',
    description:
      'Answers the open question an agent asked on a task (show_task shows it). When the person picks one of the options the question offers, pass its letter as `option`, plus anything they added as `answer`; otherwise pass their answer in their words. If they are unsure, it is fine to answer "I don\'t know, choose what is simplest". The agent resumes as soon as it is answered.',
    input: z.object({
      project: PROJECT,
      number: NUMBER,
      option: z
        .string()
        .trim()
        .min(1)
        .max(2)
        .optional()
        .describe('The letter of the option the person chose, as show_task lists it ("a", "b").'),
      answer: z
        .string()
        .trim()
        .min(1)
        .max(10_000)
        .optional()
        .describe('The answer in plain language, or a note on the chosen option.')
    }),
    readOnly: false,
    run: async (context, input) => {
      const project = projectFor(context, input.project);
      if (!input.option && !input.answer)
        throw new ToolError('Pass the chosen option, the answer in words, or both.');
      await actOnTaskAs(context.pool, {
        projectId: project.id,
        memberId: context.memberId,
        number: input.number,
        action: { type: 'answer', text: input.answer ?? '', option: input.option }
      });
      return `Answered; the work on task ${input.number} continues: ${taskUrl(context.publicUrl, project.id, input.number)}`;
    }
  }),
  tool({
    name: 'comment',
    title: 'Comment on a task',
    description:
      "Adds a comment to a task's conversation, for context, a screenshot description or a correction. Agents read comments as information. To answer an open question use answer_question instead, so the work resumes.",
    input: z.object({
      project: PROJECT,
      number: NUMBER,
      text: z.string().trim().min(1).max(20_000).describe('The comment, in plain language.')
    }),
    readOnly: false,
    run: async (context, input) => {
      const project = projectFor(context, input.project);
      await commentAs(context.pool, {
        projectId: project.id,
        memberId: context.memberId,
        number: input.number,
        text: input.text
      });
      return `Comment added to task ${input.number}: ${taskUrl(context.publicUrl, project.id, input.number)}`;
    }
  }),
  tool({
    name: 'review',
    title: 'Approve or ask for changes',
    description: `Records the person's decision at one of the two moments people decide:
- a plan to approve (before anything is built): "approve" sends it to be built;
- a result to check (after it is built): "approve" is the "Looks good" button. Officina then approves the pull request on GitHub as them if they connected GitHub; depending on the project, a person merges it or GitHub does once its checks pass.
"changes" sends it back to the agents with the note, which must say what is wrong or missing.

Always call show_task first, show the person the plan or the list of what to check, and only approve when they say they read the plan or checked every item. Never approve on their behalf without that.`,
    input: z.object({
      project: PROJECT,
      number: NUMBER,
      decision: z.enum(['approve', 'changes']),
      note: z
        .string()
        .trim()
        .max(10_000)
        .optional()
        .describe('Required for "changes": what is wrong, in plain language.')
    }),
    readOnly: false,
    run: async (context, input) => {
      const project = projectFor(context, input.project);
      if (input.decision === 'changes' && !input.note)
        throw new ToolError('Say what should change: the note is required to ask for changes.');
      const result = await actOnTaskAs(context.pool, {
        projectId: project.id,
        memberId: context.memberId,
        number: input.number,
        action:
          input.decision === 'approve'
            ? { type: 'approve' }
            : { type: 'changes', note: input.note! }
      });
      const outcome =
        input.decision === 'changes'
          ? 'Changes requested; the agents work on it again.'
          : result.satisfied === false
            ? 'Your approval is recorded; more approvals are still needed.'
            : 'Approved.';
      return `${outcome} Task ${input.number}: ${taskUrl(context.publicUrl, project.id, input.number)}`;
    }
  })
] as const;

/** The tool definitions as MCP `tools/list` returns them. */
export const toolDefinitions = () =>
  TOOLS.map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.input, { io: 'input' }),
    annotations: {
      title: definition.title,
      readOnlyHint: definition.readOnly,
      destructiveHint: false,
      openWorldHint: false
    }
  }));

/** Runs a tool; a refusal or a bad input becomes a message for the person, never a crash. */
export const callTool = async (
  context: ToolContext,
  name: string,
  args: unknown
): Promise<Outcome | null> => {
  const definition = TOOLS.find((candidate) => candidate.name === name);
  if (!definition) return null;
  try {
    return await definition.call(context, args);
  } catch (error) {
    if (error instanceof ToolError || error instanceof TaskCommandError)
      return { text: error.message, isError: true };
    throw error;
  }
};
