/**
 * Local board development: a throwaway Postgres with a demo workshop in every stage, the API on
 * :8080 and simulated agents that keep working, so the board can be seen live without real runs.
 *
 *   bun run dev          # this server
 *   bun run dev:board    # the board with hot reload on :5173, proxied to this server
 */
import { join } from 'node:path';
import type { Actor, Command } from '@officina/core';
import {
  appendRunEvent,
  applyCommand,
  createLoginLink,
  createTask,
  finishRun,
  insertLearnings,
  migrate,
  saveSpecVersion,
  setProjectRole,
  startRun,
  upsertMember,
  upsertProject,
  upsertWorkspace
} from '@officina/db';
import { Pool } from 'pg';
import { createApp } from './app';
import { startRealtime } from './realtime';

const CONTAINER = 'officina-dev';
const PORT = 55_433;

const sh = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  return proc.exited;
};

const startDatabase = async (): Promise<string> => {
  await sh(['docker', 'rm', '-f', CONTAINER]);
  const started = await sh([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    CONTAINER,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-p',
    `${PORT}:5432`,
    'postgres:17-alpine'
  ]);
  if (started !== 0) throw new Error('could not start Postgres in Docker');
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await sh(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres'])) === 0) break;
    await Bun.sleep(500);
  }
  await Bun.sleep(500);
  return `postgres://postgres@localhost:${PORT}/postgres`;
};

const CONFIG = {
  version: 1,
  docs: { entry: 'AGENTS.md', spec_dir: 'docs/specs' },
  verify: ['npm run lint', 'npm run check'],
  lanes: {
    red: {
      agents_build: false,
      approvals: { spec_review: [{ role: 'owner' }] },
      paths: ['src/lib/auth/**', '.github/**']
    },
    standard: {
      paths: ['**'],
      approvals: {
        spec_review: [{ role: 'owner' }],
        verifying: [{ domain: 'product', when: 'user_visible' }, { role: 'owner' }]
      }
    },
    green: {
      paths: ['src/lib/i18n/**'],
      approvals: { spec_review: [{ requester: true }], verifying: [{ requester: true }] }
    }
  }
};

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

const spec = (title: string, goal: string) => `# Spec: ${title}

Status: Draft

## Goal

${goal}

## Scope

| File | Change |
| --- | --- |
| \`src/lib/i18n/en.ts\` | Update the affected strings |
| \`src/lib/components/Card.svelte\` | Read the new keys |

## Out of scope

- Any change to how values are stored.
- Other screens that use similar wording.

## Acceptance criteria

1. The screen shows the new wording in every live locale.
2. No key is added, removed or renamed.
3. \`npm run check\` passes.
`;

const SCRIPT: [string, unknown][] = [
  ['agent.message', text("I'll start by reading the project's entry document and the spec.")],
  ['agent.tool_use', { name: 'bash', input: { command: 'cat AGENTS.md | head -80' } }],
  [
    'agent.tool_result',
    text('# AGENTS.md\n\nRead this first. Conventions, commands and boundaries...')
  ],
  ['agent.thinking', {}],
  ['agent.tool_use', { name: 'read', input: { file_path: 'src/lib/components/Card.svelte' } }],
  ['agent.tool_result', text('<script lang="ts">\n  interface Props { ... }\n</script>\n...')],
  ['agent.tool_use', { name: 'grep', input: { pattern: 'battle.detail.wager' } }],
  [
    'agent.tool_result',
    text('src/lib/i18n/en.ts:412\nsrc/lib/i18n/it.ts:412\nsrc/lib/i18n/de.ts:412')
  ],
  ['agent.message', text('The keys are used in two components. Updating the catalogs now.')],
  ['agent.tool_use', { name: 'edit', input: { file_path: 'src/lib/i18n/en.ts' } }],
  ['agent.tool_result', text('Edited 3 lines.')],
  ['agent.tool_use', { name: 'bash', input: { command: 'npm run check' } }],
  ['agent.thinking', {}],
  ['agent.tool_result', text('svelte-check found 0 errors and 0 warnings')]
];

interface Demo {
  pool: Pool;
  projectId: string;
  owner: Actor;
  giulia: Actor;
  marco: Actor;
}

const agent = (role: string): Actor => ({ kind: 'agent', role, version: 3 }) as Actor;
const engine: Actor = { kind: 'engine' };

const apply = async (demo: Demo, taskId: string, command: Command, actor: Actor) => {
  const result = await applyCommand(demo.pool, { taskId, command, actor });
  if (!result.ok) throw new Error(`${command.type}: ${result.error}`);
  return result.task;
};

const run = async (
  demo: Demo,
  taskId: string,
  stage: string,
  role: string,
  options: { events?: number; result?: unknown; cost?: number; running?: boolean }
) => {
  const claim = await startRun(demo.pool, {
    taskId,
    stage,
    role,
    agentVersion: 3,
    runner: 'managed_agents'
  });
  if (!claim.ok) throw new Error('run not started');
  await demo.pool.query(
    "update runs set external_id = $2, started_at = now() - interval '6 minutes' where id = $1",
    [claim.runId, `sesn_demo_${claim.runId.slice(0, 8)}`]
  );
  await appendRunEvent(
    demo.pool,
    claim.runId,
    'user.message',
    text(`# Officina task, role: ${role}\n\nRead AGENTS.md first...`)
  );
  for (const [type, payload] of SCRIPT.slice(0, options.events ?? SCRIPT.length)) {
    await appendRunEvent(demo.pool, claim.runId, type, payload);
  }
  if (options.running) return claim.runId;
  await appendRunEvent(demo.pool, claim.runId, 'agent.custom_tool_use', {
    name: 'submit_result',
    input: { result: options.result ?? { outcome: 'done' } }
  });
  await finishRun(demo.pool, claim.runId, {
    status: 'succeeded',
    costCents: options.cost ?? 60,
    result: options.result ?? {}
  });
  await demo.pool.query(
    "update runs set finished_at = started_at + interval '4 minutes 12 seconds' where id = $1",
    [claim.runId]
  );
  return claim.runId;
};

const COPY = 'src/lib/i18n/en.ts';
const UI = 'src/lib/components/Card.svelte';

const seed = async (
  demo: Demo,
  input: { title: string; request: string; by: Actor; paths: string[] }
) => {
  const requesterId = input.by.kind === 'member' ? input.by.memberId : '';
  const { task } = await createTask(demo.pool, {
    projectId: demo.projectId,
    title: input.title,
    requesterId
  });
  await demo.pool.query('insert into comments (task_id, author, body) values ($1, $2, $3)', [
    task.id,
    JSON.stringify(input.by),
    input.request
  ]);
  await apply(demo, task.id, { type: 'submit_request' }, input.by);
  const giuliaId = demo.giulia.kind === 'member' ? demo.giulia.memberId : '';
  const planFor = (paths: readonly string[]) =>
    paths.some((path) => path.includes('auth'))
      ? {
          depth: 'test' as const,
          rationale:
            'Session keys protect every account; a mistake signs people out or lets old sessions live on.',
          extra: [
            { requirement: { role: 'owner' as const }, reason: 'Security-sensitive change.' }
          ],
          verifiers: []
        }
      : paths.some((path) => path.includes('i18n'))
        ? {
            depth: 'glance' as const,
            rationale: 'Copy only: the before and after table is enough to judge it.',
            extra: [],
            verifiers: [{ memberId: giuliaId, reason: 'Owns the product wording.' }]
          }
        : {
            depth: 'device' as const,
            rationale: 'A visible change on a screen people use daily; check it on a phone.',
            extra: [{ requirement: { domain: 'product' }, reason: 'Changes what people see.' }],
            verifiers: [{ memberId: giuliaId, reason: 'Product approver.' }]
          };
  const steps = {
    id: task.id,
    accept: () => apply(demo, task.id, { type: 'accept' }, demo.owner),
    spec: async (running = false, plan = true) => {
      if (running) return run(demo, task.id, 'speccing', 'spec', { events: 6, running: true });
      await run(demo, task.id, 'speccing', 'spec', { cost: 84, result: { outcome: 'specced' } });
      const next = await apply(
        demo,
        task.id,
        { type: 'post_spec', predictedPaths: input.paths, userVisible: true },
        agent('spec')
      );
      await saveSpecVersion(demo.pool, {
        taskId: task.id,
        version: next.specVersion,
        body: spec(input.title, input.request),
        createdBy: agent('spec')
      });
      if (!plan) return run(demo, task.id, 'spec_review', 'chooser', { events: 5, running: true });
      await run(demo, task.id, 'spec_review', 'chooser', {
        cost: 22,
        result: { outcome: 'planned' }
      });
      await apply(
        demo,
        task.id,
        { type: 'plan_approval', userVisible: true, plan: planFor(input.paths) },
        agent('chooser')
      );
    },
    // Approves as each listed person in turn until the gate opens, whatever the plan required.
    approve: async (actors: Actor[]) => {
      for (const actor of [...actors, demo.owner, demo.giulia]) {
        const before = await apply(demo, task.id, { type: 'approve' }, actor);
        if (before.stage !== 'spec_review' && before.stage !== 'verifying') return;
      }
    },
    build: async (running = false) => {
      await apply(
        demo,
        task.id,
        {
          type: 'dispatch',
          assignee: { kind: 'agent', role: 'builder' },
          openInLane: 0
        },
        engine
      );
      if (running) return run(demo, task.id, 'building', 'builder', { events: 9, running: true });
      await run(demo, task.id, 'building', 'builder', { cost: 212, result: { outcome: 'pushed' } });
      await apply(
        demo,
        task.id,
        {
          type: 'push',
          headSha: 'cbefa7769acd0115833fa190d22ab6d92c4ff612',
          changedPaths: input.paths,
          addedPaths: [],
          catalogPages: {},
          diffLines: 48
        },
        agent('builder')
      );
      await demo.pool.query('update tasks set github_pr = $2 where id = $1', [
        task.id,
        1300 + Math.floor(Math.random() * 60)
      ]);
    },
    review: async (running = false) => {
      if (running) {
        await run(demo, task.id, 'reviewing', 'reviewer_spec', { events: 4, running: true });
        return run(demo, task.id, 'reviewing', 'reviewer_correctness', {
          events: 7,
          running: true
        });
      }
      for (const role of ['reviewer_spec', 'reviewer_correctness'] as const) {
        await run(demo, task.id, 'reviewing', role, { cost: 95, result: { outcome: 'approve' } });
        await apply(
          demo,
          task.id,
          { type: 'review', verdict: 'approve', notes: 'Matches the spec; checks pass.' },
          agent(role)
        );
      }
    },
    choose: async () => {
      const result = {
        userVisible: true,
        checklist: [
          'Open Arena, then Battles, and start a battle: the slider label reads "On the line (optional)".',
          'Leave the slider at zero: the value reads "Pride only".',
          'Switch the language to Italian and German and check the same two strings.',
          'Confirm the legal footer wording did not change.'
        ],
        beforeAfter: [
          {
            key: 'battles.create.label_wager',
            locale: 'en',
            before: 'Wager (optional)',
            after: 'On the line (optional)'
          },
          {
            key: 'battles.create.wager_none',
            locale: 'en',
            before: 'No stake',
            after: 'Pride only'
          },
          {
            key: 'battles.create.label_wager',
            locale: 'it',
            before: 'Posta (facoltativa)',
            after: 'In gioco (facoltativo)'
          },
          {
            key: 'battles.create.wager_none',
            locale: 'it',
            before: 'Nessuna posta',
            after: 'Solo per l’onore'
          },
          {
            key: 'battles.create.label_wager',
            locale: 'de',
            before: 'Einsatz (optional)',
            after: 'Im Spiel (optional)'
          }
        ]
      };
      await run(demo, task.id, 'choosing', 'chooser', { cost: 41, result });
      await apply(
        demo,
        task.id,
        { type: 'choose', userVisible: true, plan: planFor(input.paths) },
        agent('chooser')
      );
    }
  };
  return steps;
};

const seedDemo = async (pool: Pool) => {
  const workspaceId = await upsertWorkspace(pool, 'demo');
  const ownerId = await upsertMember(pool, {
    workspaceId,
    email: 'owner@example.com',
    displayName: 'Antonio Ventilii'
  });
  const giuliaId = await upsertMember(pool, {
    workspaceId,
    email: 'giulia@example.com',
    displayName: 'Giulia Conti'
  });
  const marcoId = await upsertMember(pool, {
    workspaceId,
    email: 'marco@example.com',
    displayName: 'Marco Bassi'
  });
  const projectId = await upsertProject(pool, {
    workspaceId,
    name: 'shop',
    repo: 'demo/shop',
    installationId: 1,
    defaultBranch: 'main',
    config: CONFIG
  });
  await setProjectRole(pool, { projectId, memberId: ownerId, role: 'owner' });
  await setProjectRole(pool, {
    projectId,
    memberId: giuliaId,
    role: 'contributor',
    domains: ['product']
  });
  await setProjectRole(pool, { projectId, memberId: marcoId, role: 'maintainer' });
  const owner: Actor = { kind: 'member', memberId: ownerId };
  const giulia: Actor = { kind: 'member', memberId: giuliaId };
  const marco: Actor = { kind: 'member', memberId: marcoId };
  const demo: Demo = { pool, projectId, owner, giulia, marco };

  const done = await seed(demo, {
    title: 'Show dates in the reader’s locale',
    request: 'Market dates are always in US format. Use the reader’s locale.',
    by: giulia,
    paths: [UI]
  });
  await done.accept();
  await done.spec();
  await done.approve([owner]);
  await done.build();
  await done.review();
  await done.choose();
  await done.approve([owner, giulia]);
  await apply(demo, done.id, { type: 'merged' }, engine);
  const learnerRun = await run(demo, done.id, 'done', 'learner', { cost: 31, result: {} });
  await insertLearnings(pool, {
    projectId,
    taskId: done.id,
    runId: learnerRun,
    learnings: [
      {
        title: 'Dates go through the shared formatter',
        lesson:
          'Anything that shows a date must use the shared locale formatter; hand-built strings keep the US format.',
        evidence:
          'The code reviewer sent the first build back: two components built dates by hand and kept the US format.',
        target: 'docs',
        edit: {
          file: 'AGENTS.md',
          find: '## Conventions\n',
          text: '## Conventions\n\n- Show dates with the shared locale formatter, never by hand.\n'
        }
      },
      {
        title: 'Builders run the locale check before pushing',
        lesson:
          'The builder should run the locale alignment check whenever it touches user-facing text.',
        evidence:
          'Round one failed CI on locale alignment; round two passed after the builder ran it.',
        target: 'agent',
        edit: {
          file: 'agents/builder.md',
          text: 'When you change user-facing text, run the project locale check before pushing.'
        }
      }
    ]
  });

  const merging = await seed(demo, {
    title: 'Dark mode for the rules page',
    request: 'The rules page ignores dark mode.',
    by: owner,
    paths: [UI]
  });
  await merging.accept();
  await merging.spec();
  await merging.approve([owner]);
  await merging.build();
  await merging.review();
  await merging.choose();
  await merging.approve([owner, giulia]);

  const verifying = await seed(demo, {
    title: 'Replace wager wording in battle copy',
    request:
      'Battle screens say **Wager** and *No stake*. Use prediction wording everywhere, keep the legal footer as it is.',
    by: owner,
    paths: [COPY]
  });
  await verifying.accept();
  await verifying.spec();
  await verifying.approve([owner]);
  await verifying.build();
  await verifying.review();
  await verifying.choose();

  const reviewing = await seed(demo, {
    title: 'Portuguese onboarding tips',
    request: 'Onboarding tips are missing in Portuguese.',
    by: giulia,
    paths: [COPY]
  });
  await reviewing.accept();
  await reviewing.spec();
  await reviewing.approve([giulia, owner]);
  await reviewing.build();
  await reviewing.review(true);

  const building = await seed(demo, {
    title: 'Show streak freeze tokens on the profile',
    request: 'People can’t see how many streak freezes they have left.',
    by: giulia,
    paths: [UI]
  });
  await building.accept();
  await building.spec();
  await building.approve([owner]);
  await building.build(true);

  const blocked = await seed(demo, {
    title: 'Tidy up the leaderboard empty state',
    request: 'An empty leaderboard shows a blank box.',
    by: marco,
    paths: [UI]
  });
  await blocked.accept();
  await blocked.spec();
  await blocked.approve([owner]);
  await apply(
    demo,
    blocked.id,
    {
      type: 'dispatch',
      assignee: { kind: 'agent', role: 'builder' },
      openInLane: 0
    },
    engine
  );
  await apply(
    demo,
    blocked.id,
    {
      type: 'block',
      question:
        'Should the empty state show last week’s winners, or only an invitation to make the first prediction?',
      askedOf: { role: 'maintainer' }
    },
    agent('builder')
  );

  const ready = await seed(demo, {
    title: 'Clearer copy on the settings page',
    request: 'Settings labels are cryptic.',
    by: owner,
    paths: [COPY]
  });
  await ready.accept();
  await ready.spec();
  await ready.approve([owner]);

  const specReview = await seed(demo, {
    title: 'Explain why a market is closed',
    request: 'When a market closes early, people don’t know why. Show the reason on the card.',
    by: giulia,
    paths: [UI]
  });
  await specReview.accept();
  await specReview.spec(false, false);

  const red = await seed(demo, {
    title: 'Rotate the session signing key',
    request: 'Rotate the key and keep old sessions valid for a day.',
    by: marco,
    paths: ['src/lib/auth/session.ts']
  });
  await red.accept();
  await red.spec();

  const speccing = await seed(demo, {
    title: 'Fix the duplicated toast after a prediction',
    request: 'Two toasts appear after confirming a prediction.',
    by: marco,
    paths: [UI]
  });
  await speccing.accept();
  await speccing.spec(true);

  await seed(demo, {
    title: 'Let league admins pin a message',
    request: 'League admins want to pin one message at the top of the league chat.',
    by: giulia,
    paths: [UI]
  });

  const declined = await seed(demo, {
    title: 'Replace the confetti animation',
    request: 'Confetti is too much.',
    by: giulia,
    paths: [UI]
  });
  await apply(
    demo,
    declined.id,
    { type: 'decline', reason: 'We keep it until the next brand refresh.' },
    owner
  );

  // Spread each task's history over the last days, keeping its order and ending before now. The
  // audit tables refuse updates, so this throwaway database skips their triggers for the rewrite.
  const client = await pool.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(`
      update tasks set created_at = now() - interval '10 hours' - random() * interval '4 days'`);
    await client.query(`
      with ordered as (
        select e.id, t.created_at
          + row_number() over (partition by e.task_id order by e.id) * interval '23 minutes' as at
        from task_events e join tasks t on t.id = e.task_id
      )
      update task_events e set created_at = o.at from ordered o where o.id = e.id`);
    await client.query(`
      update comments c set created_at = t.created_at from tasks t where t.id = c.task_id`);
    await client.query(`
      update spec_versions s set created_at = t.created_at + interval '40 minutes'
      from tasks t where t.id = s.task_id`);
    await client.query(`
      update runs r set
        created_at = t.created_at + interval '30 minutes',
        started_at = case when r.status = 'running' then now() - interval '6 minutes'
                          else t.created_at + interval '30 minutes' end,
        finished_at = case when r.status = 'running' then null
                           else t.created_at + interval '34 minutes 12 seconds' end
      from tasks t where t.id = r.task_id`);
  } finally {
    await client.query('reset session_replication_role');
    client.release();
  }
  return { ownerId };
};

/** Keeps the running sessions busy, a step every second or so. */
const simulate = (pool: Pool) => {
  let step = 0;
  return setInterval(async () => {
    const { rows } = await pool.query<{ id: string }>(
      "select id from runs where status = 'running'"
    );
    for (const row of rows) {
      const [type, payload] = SCRIPT[(step + row.id.charCodeAt(0)) % SCRIPT.length]!;
      await appendRunEvent(pool, row.id, type, payload);
    }
    step++;
  }, 1400);
};

if (import.meta.main) {
  const url = process.env.DEV_DATABASE_URL ?? (await startDatabase());
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url))
    throw new Error('dev only resets a local database');
  const pool = new Pool({ connectionString: url });
  await pool.query('drop schema public cascade; create schema public;');
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }
  const { ownerId } = await seedDemo(pool);
  const realtime = await startRealtime({ connectionString: url, pool, log: console.log });
  const boardUrl = process.env.BOARD_URL ?? 'http://localhost:5173';
  createApp({
    pool,
    webhookSecret: 'dev-'.repeat(10),
    board: { publicUrl: boardUrl, consoleWorkspace: 'wrkspc_demo', realtime },
    boardDir: join(import.meta.dir, '..', '..', 'board', 'build')
  }).listen({ port: 8080, hostname: '127.0.0.1' });
  simulate(pool);
  const token = await createLoginLink(pool, ownerId, 24 * 60 * 60 * 1000);
  console.log(
    `\nOfficina dev API on http://localhost:8080 with a demo workshop.\nSign in: ${boardUrl}/signin#${token}\n`
  );
}
