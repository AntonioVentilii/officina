import { describe, expect, test } from 'bun:test';
import {
  commandForOutput,
  findOption,
  newTask,
  optionAnswer,
  parseAgentOutput,
  questionMarkdown,
  type QuestionOption
} from '../src';

const task = newTask('t1', 'gio');

const OPTIONS: QuestionOption[] = [
  {
    label: 'Say it is a hypothesis',
    detail: 'The public room labels it plainly.',
    preview: { kind: 'text', before: 'Our thesis', after: 'Our hypothesis (not yet proven)' }
  },
  {
    label: 'Show the evidence first',
    preview: { kind: 'html', body: '<section><h2>Evidence</h2><p>Three pilots…</p></section>' }
  },
  { label: 'Leave it out', preview: { kind: 'markdown', body: '_Nothing is shown._' } },
  {
    label: 'See the preview build',
    preview: { kind: 'link', url: 'https://preview.example.com/room', label: 'Preview build' }
  }
];

describe('question options and previews', () => {
  test('an interviewer question carries its options into the block command', () => {
    const asked = parseAgentOutput('interviewer', {
      outcome: 'question',
      question: 'What should the public room say about the hypothesis?',
      options: OPTIONS
    });
    if (!asked.ok) throw new Error(asked.errors.join());
    expect(commandForOutput(task, { role: 'interviewer', output: asked.output })).toEqual({
      ok: true,
      command: {
        type: 'block',
        question: 'What should the public room say about the hypothesis?',
        askedOf: { memberId: 'gio' },
        options: OPTIONS
      }
    });
  });

  test('a question without options works as before and the command has no options', () => {
    const asked = parseAgentOutput('interviewer', { outcome: 'question', question: 'Which page?' });
    if (!asked.ok) throw new Error(asked.errors.join());
    expect(commandForOutput(task, { role: 'interviewer', output: asked.output })).toEqual({
      ok: true,
      command: { type: 'block', question: 'Which page?', askedOf: { memberId: 'gio' } }
    });
  });

  test('a spec question may offer options; a builder question may not', () => {
    const spec = parseAgentOutput('spec', {
      outcome: 'blocked',
      question: 'Which wording?',
      askedOf: 'requester',
      options: OPTIONS.slice(0, 2)
    });
    if (!spec.ok) throw new Error(spec.errors.join());
    expect(commandForOutput(task, { role: 'spec', output: spec.output })).toMatchObject({
      command: { type: 'block', options: OPTIONS.slice(0, 2) }
    });
    expect(
      parseAgentOutput('builder', {
        outcome: 'blocked',
        question: 'Which wording?',
        options: OPTIONS.slice(0, 2)
      }).ok
    ).toBe(false);
  });

  test('previews are checked: a known kind, https links only, two to six options', () => {
    const ask = (options: unknown) =>
      parseAgentOutput('interviewer', { outcome: 'question', question: 'Which?', options }).ok;
    const link = (url: string) => [{ label: 'A', preview: { kind: 'link', url } }, { label: 'B' }];
    expect(ask(link('https://example.com/shot.png'))).toBe(true);
    expect(ask(link('http://example.com/shot.png'))).toBe(false);
    expect(ask(link('javascript:alert(1)'))).toBe(false);
    expect(ask([{ label: 'A', preview: { kind: 'script', body: 'x' } }, { label: 'B' }])).toBe(
      false
    );
    expect(ask([{ label: 'A', preview: { kind: 'html', body: '  ' } }, { label: 'B' }])).toBe(
      false
    );
    expect(ask([{ label: 'Only one' }])).toBe(false);
    expect(ask(Array.from({ length: 7 }, (_, index) => ({ label: `Option ${index}` })))).toBe(
      false
    );
    expect(ask([{ label: 'A', extra: true }, { label: 'B' }])).toBe(false);
  });

  test('options go by letter in the thread, and a picked one becomes a plain answer', () => {
    expect(questionMarkdown('Which?', OPTIONS.slice(0, 2))).toBe(
      'Which?\n\n- **(a) Say it is a hypothesis**: The public room labels it plainly.\n- **(b) Show the evidence first**'
    );
    expect(questionMarkdown('Which?', undefined)).toBe('Which?');
    expect(findOption(OPTIONS, 'c')?.label).toBe('Leave it out');
    expect(findOption(OPTIONS, 'z')).toBeUndefined();
    expect(findOption(undefined, 'a')).toBeUndefined();
    expect(optionAnswer('b', OPTIONS[1]!)).toBe('Option (b): Show the evidence first');
    expect(optionAnswer('b', OPTIONS[1]!, ' but shorter ')).toBe(
      'Option (b): Show the evidence first\n\nbut shorter'
    );
  });
});
