import { describe, expect, test } from 'bun:test';
import { interviewOffer, interviewsByDefault, interviewsRequest, type Member } from '../src';
import { loadConfig, owner, productContributor } from './fixtures';

const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };
const interviewing = { ok: true, config: loadConfig() } as const;
const notInterviewing = {
  ok: true,
  config: { ...interviewing.config, intake: { interview: false } }
} as const;
const broken = { ok: false, errors: ['version: required'] } as const;

describe('the interview of a new request', () => {
  test('is skipped by default for whoever may triage, and held for everyone else', () => {
    expect(interviewsByDefault(owner)).toBe(false);
    expect(interviewsByDefault(maintainer)).toBe(false);
    expect(interviewsByDefault(productContributor)).toBe(true);
  });

  test('follows what the requester asked, either way', () => {
    expect(interviewsRequest(interviewing, owner, true)).toBe(true);
    expect(interviewsRequest(interviewing, productContributor, false)).toBe(false);
    expect(interviewsRequest(interviewing, owner, undefined)).toBe(false);
    expect(interviewsRequest(interviewing, productContributor, undefined)).toBe(true);
  });

  test('never happens in a project that turned interviews off, and the form offers no choice', () => {
    expect(interviewsRequest(notInterviewing, productContributor, true)).toBe(false);
    expect(interviewOffer(notInterviewing, productContributor)).toBeNull();
    expect(interviewOffer(interviewing, productContributor)).toBe(true);
    expect(interviewOffer(interviewing, owner)).toBe(false);
  });

  test('keeps the default when the config does not parse', () => {
    expect(interviewsRequest(broken, productContributor, undefined)).toBe(true);
  });
});
