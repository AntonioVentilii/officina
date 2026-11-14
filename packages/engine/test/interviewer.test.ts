import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { QuestionOption } from '@officina/core';
import { addComment, applyCommand, createTask, loadTask, saveAgentVersion } from '@officina/db';
import { RUNNER_ROLES } from '@officina/runner';
import { Pool } from 'pg';
import { resetAndSeed, type Seeded } from '../../db/test/seed';
import { createFakePort, idle, toolUse } from '../../runner/test/fake-port';
import { collectDueSteps, runAgentStep } from '../src';
import { gitHubWith } from './fake-github';

const url = process.env.TEST_DATABASE_URL;

const github = gitHubWith({ installationToken: async () => 'token-read' });

describe.skipIf(!url)('interviewer', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
    await pool.query(
      "update projects set github_installation_id = 99, agent_environment_id = 'env_1' where id = $1",
      [seeded.projectId]
    );
    for (const role of RUNNER_ROLES) {
      await saveAgentVersion(pool, {
        role,
        externalAgentId: `agent_${role}`,
        version: 1,
        definitionHash: 'h'
      });
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  const draft = async () => {
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Wager wording',
      requesterId: seeded.ownerId
    });
    await addComment(pool, task.id, seeded.owner, 'Battles say Wager. Fix it.');
    return task.id;
  };

  const comments = async (taskId: string) =>
    (
      await pool.query<{ body: string; role: string | null }>(
        "select body, author->>'role' as role from comments where task_id = $1 order by created_at, id",
        [taskId]
      )
    ).rows;

  test('asks the requester, reads the answer, then hands a clear request to triage', async () => {
    const taskId = await draft();
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([
      { taskId, role: 'interviewer' }
    ]);

    let reply: unknown = { outcome: 'question', question: 'Battles only, or leagues too?' };
    const agents = createFakePort(() => [
      toolUse(reply),
      idle('requires_action'),
      idle('end_turn')
    ]);
    const deps = { pool, github, agents, publicUrl: 'https://o.example' };

    expect(await runAgentStep(deps, taskId, 'interviewer')).toEqual({ status: 'applied' });
    let task = (await loadTask(pool, taskId))!.task;
    expect(task).toMatchObject({
      stage: 'request',
      blocked: { askedOf: { memberId: seeded.ownerId } }
    });
    const brief = (agents.sent[0]!.events[0] as { text: string }).text;
    expect(brief).toContain('Battles say Wager. Fix it.');
    expect(brief).toContain('Questions asked so far: 0 of 4');

    const answered = await applyCommand(pool, {
      taskId,
      command: { type: 'answer', text: 'Battles only.' },
      actor: seeded.owner
    });
    expect(answered.ok).toBe(true);
    await addComment(pool, taskId, seeded.owner, 'Battles only.');

    reply = {
      outcome: 'complete',
      title: 'Replace betting words in battle copy',
      summary: 'Battle screens use betting words; use prediction wording.',
      acceptance: ['No battle screen says Wager.']
    };
    expect(await runAgentStep(deps, taskId, 'interviewer')).toEqual({ status: 'applied' });
    task = (await loadTask(pool, taskId))!.task;
    expect(task.stage).toBe('triage');
    const title = await pool.query('select title from tasks where id = $1', [taskId]);
    expect(title.rows[0].title).toBe('Replace betting words in battle copy');
    expect(await comments(taskId)).toEqual([
      { body: 'Battles say Wager. Fix it.', role: null },
      { body: 'Battles only, or leagues too?', role: 'interviewer' },
      { body: 'Battles only.', role: null },
      {
        body: '**Summary.** Battle screens use betting words; use prediction wording.\n\n**Done when:**\n- No battle screen says Wager.',
        role: 'interviewer'
      }
    ]);
  });

  test('a question with options and previews is stored on the task and listed in the thread', async () => {
    const taskId = await draft();
    const options: QuestionOption[] = [
      {
        label: 'Say Prediction',
        preview: { kind: 'text', before: 'Place a wager', after: 'Make a prediction' }
      },
      { label: 'Say Pick', detail: 'Shorter on small screens.' }
    ];
    const agents = createFakePort(() => [
      toolUse({ outcome: 'question', question: 'Which word instead?', options }),
      idle('requires_action'),
      idle('end_turn')
    ]);
    const deps = { pool, github, agents, publicUrl: 'https://o.example' };

    expect(await runAgentStep(deps, taskId, 'interviewer')).toEqual({ status: 'applied' });
    expect((await loadTask(pool, taskId))!.task.blocked).toEqual({
      question: 'Which word instead?',
      askedOf: { memberId: seeded.ownerId },
      options
    });
    expect((await comments(taskId)).at(-1)).toEqual({
      body: 'Which word instead?\n\n- **(a) Say Prediction**\n- **(b) Say Pick**: Shorter on small screens.',
      role: 'interviewer'
    });
  });

  test('after four questions the interviewer must finish', async () => {
    const taskId = await draft();
    for (let index = 0; index < 4; index++) {
      await pool.query(
        `insert into task_events (task_id, actor, type, payload) values ($1, $2, 'blocked', '{}')`,
        [taskId, JSON.stringify({ kind: 'agent', role: 'interviewer', version: 1 })]
      );
    }
    const agents = createFakePort(() => [
      toolUse({ outcome: 'question', question: 'One more?' }),
      idle('requires_action'),
      toolUse({
        outcome: 'complete',
        title: 'Wager wording',
        summary: 'Enough.',
        acceptance: ['Done.']
      }),
      idle('requires_action'),
      idle('end_turn')
    ]);
    const deps = { pool, github, agents, publicUrl: 'x' };
    expect(await runAgentStep(deps, taskId, 'interviewer')).toEqual({ status: 'applied' });
    expect(JSON.stringify(agents.sent)).toContain('complete the request now');
    expect((await loadTask(pool, taskId))!.task.stage).toBe('triage');
  });
});
