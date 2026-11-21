import { describe, expect, test } from 'bun:test';
import { interviewsByDefault, interviewsRequest, type Member } from '../src';
import { owner, productContributor } from './fixtures';

const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };

describe('the interview of a new request', () => {
  test('is skipped by default for whoever may triage, and held for everyone else', () => {
    expect(interviewsByDefault(owner)).toBe(false);
    expect(interviewsByDefault(maintainer)).toBe(false);
    expect(interviewsByDefault(productContributor)).toBe(true);
  });

  test('follows what the requester asked, either way', () => {
    expect(interviewsRequest(true, owner, true)).toBe(true);
    expect(interviewsRequest(true, productContributor, false)).toBe(false);
    expect(interviewsRequest(true, owner, undefined)).toBe(false);
    expect(interviewsRequest(true, productContributor, undefined)).toBe(true);
  });

  test('never happens in a project that turned interviews off', () => {
    expect(interviewsRequest(false, productContributor, true)).toBe(false);
  });
});
