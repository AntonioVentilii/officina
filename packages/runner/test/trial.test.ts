import { describe, expect, test } from 'bun:test';
import {
  PINNED_MODELS,
  PROMPTS_DIR,
  READER_NAME,
  loadDefinitions,
  syncTrialBuilder,
  trialBuilders
} from '../src';
import { createFakePort } from './fake-port';

describe('trial builders', () => {
  test('the reader arm is the production builder and the solo arm the same builder without the reader, both under trial names', async () => {
    const [arms, definitions] = await Promise.all([
      trialBuilders(PROMPTS_DIR, PINNED_MODELS),
      loadDefinitions(PROMPTS_DIR, PINNED_MODELS)
    ]);
    const production = definitions.find((definition) => definition.role === 'builder')!;

    expect(arms.reader.name).toBe('officina-trial-builder-reader');
    expect(arms.reader.reader?.name).toBe('officina-trial-reader');
    expect(arms.reader.system).toBe(production.system);
    expect(arms.reader.tools).toEqual(production.tools);
    expect(arms.reader.model).toEqual(production.model);

    expect(arms.solo.name).toBe('officina-trial-builder-solo');
    expect(arms.solo.reader).toBeNull();
    expect(arms.solo.system).not.toContain(READER_NAME);
    expect(arms.solo.tools).toEqual(production.tools);
    expect(arms.solo.model).toEqual(production.model);
    // The same prompt and standard: only the rules for handing off reading are left out.
    expect(production.system.startsWith(arms.solo.system.split('\n---\n')[0]!)).toBe(true);

    const names = new Set(definitions.flatMap((d) => [d.name, d.reader?.name]));
    expect(names.has(arms.reader.name) || names.has(arms.solo.name)).toBe(false);
    expect(names.has(arms.reader.reader!.name)).toBe(false);
  });

  test('syncing a trial builder writes its reader first, pins it, and writes nothing on a second sync', async () => {
    const port = createFakePort(() => []);
    const { reader } = await trialBuilders(PROMPTS_DIR, PINNED_MODELS);

    const first = await syncTrialBuilder(port, reader);
    const second = await syncTrialBuilder(port, reader);

    expect(port.agentWrites.map(({ agent }) => agent.name)).toEqual([
      'officina-trial-reader',
      'officina-trial-builder-reader'
    ]);
    expect(port.agentWrites[1]!.agent.roster).toEqual([{ id: 'agent_1', version: 1 }]);
    expect(second).toEqual(first);
  });

  test('the solo builder is written with no roster', async () => {
    const port = createFakePort(() => []);
    const { solo } = await trialBuilders(PROMPTS_DIR, PINNED_MODELS);

    await syncTrialBuilder(port, solo);

    expect(port.agentWrites.map(({ agent }) => [agent.name, agent.roster])).toEqual([
      ['officina-trial-builder-solo', []]
    ]);
  });
});
