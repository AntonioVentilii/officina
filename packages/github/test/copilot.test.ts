import { describe, expect, test } from 'bun:test';
import { copilotVerdict } from '../src';

describe('copilotVerdict', () => {
  test('reads the verdict heading of a Copilot review', () => {
    const body = (heading: string) =>
      `<!-- ccr-overview-v2 -->\n\n### ${heading}\n\nWhy it says so.\n\n**No open issues**`;
    expect(copilotVerdict(body('🟢 Approval recommended'))).toBe('approval');
    expect(copilotVerdict(body('🔵 Needs a closer look'))).toBe('closer_look');
    expect(copilotVerdict(body('🟡 Changes recommended'))).toBe('changes');
  });

  test('finds none in a review that reviewed nothing', () => {
    expect(copilotVerdict("Copilot wasn't able to review any files in this pull request.")).toBe(
      null
    );
    expect(copilotVerdict('Needs a closer look, said in passing.')).toBe(null);
  });
});
