/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { QUESTION_SENTENCES } from '../src/lib/question-handed';

describe('QUESTION_SENTENCES', () => {
  const handed = QUESTION_SENTENCES.question_handed!;

  test('a handed question names the member it now waits on', () => {
    expect(handed({ memberId: 'tim', memberName: 'Tim' })).toBe('handed the question to Tim');
  });

  test('without a name it still says the question changed hands', () => {
    expect(handed({ memberId: 'gone' })).toBe('handed the question to another member');
  });
});
