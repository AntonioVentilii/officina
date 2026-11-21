/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { MODEL_SENTENCES } from '../src/lib/model-forced';

describe('MODEL_SENTENCES', () => {
  const forced = MODEL_SENTENCES.model_forced!;

  test('a forced tier is named, and one given back says the rule picks again', () => {
    expect(forced({ from: null, to: 'opus' })).toBe('forced every agent step onto opus');
    expect(forced({ from: 'opus', to: null })).toBe('gave the choice of model back to the rule');
  });

  test('a viewer who reads no tier only reads that the model changed', () => {
    expect(forced({})).toBe('changed the model its agents run on');
  });
});
