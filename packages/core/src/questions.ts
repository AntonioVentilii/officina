import { z } from 'zod';

/*
 * A question an agent asks can offer options, each with an optional preview of what people would
 * see if they chose it. Everything here is agent-written, so it is validated here and only ever
 * rendered sanitized: the board draws HTML in a sandboxed frame, never in its own page.
 */

const text = z.string().trim().min(1);

/* The descriptions reach the agents in the `submit_result` schema, so the prompts need not repeat them. */
const previewSchema = z
  .discriminatedUnion('kind', [
    z
      .strictObject({
        kind: z.literal('text'),
        before: z.string().max(2000),
        after: z.string().max(2000)
      })
      .describe('A wording change: the words people see now and the words they would see.'),
    z
      .strictObject({ kind: z.literal('markdown'), body: text.max(8000) })
      .describe('The content as it would read, in Markdown.'),
    z
      .strictObject({ kind: z.literal('html'), body: text.max(20_000) })
      .describe(
        'A small static HTML mock of the layout: inline styles, no scripts, no remote images or fonts.'
      ),
    z
      .strictObject({
        kind: z.literal('link'),
        url: z.url({ protocol: /^https$/ }),
        label: text.max(200).optional()
      })
      .describe('An https link to a screenshot or a preview build that already exists.')
  ])
  .describe('What people would see if they chose this option.');

export type Preview = z.infer<typeof previewSchema>;

const questionOptionSchema = z.strictObject({
  label: text.max(200).describe('The choice in a few plain words.'),
  detail: text.max(1000).optional(),
  preview: previewSchema.optional()
});

export type QuestionOption = z.infer<typeof questionOptionSchema>;

/** The letters options go by, in order: "(a)" to "(f)". */
const OPTION_KEYS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

export const questionOptionsSchema = z
  .array(questionOptionSchema)
  .min(2)
  .max(OPTION_KEYS.length)
  .optional();

export const optionKey = (index: number): string => OPTION_KEYS[index] ?? String(index + 1);

/** The option a key names, if the question offers it. */
export const findOption = (
  options: readonly QuestionOption[] | undefined,
  key: string
): QuestionOption | undefined => options?.find((_, index) => optionKey(index) === key);

const optionLine = (option: QuestionOption, index: number): string =>
  `- **(${optionKey(index)}) ${option.label}**${option.detail ? `: ${option.detail}` : ''}`;

/** The question as the thread keeps it: its text, then each option by its letter. */
export const questionMarkdown = (
  question: string,
  options: readonly QuestionOption[] | undefined
): string => (options?.length ? `${question}\n\n${options.map(optionLine).join('\n')}` : question);

/** The answer a picked option stands for, as the thread and the next agent read it. */
export const optionAnswer = (key: string, option: QuestionOption, note?: string): string =>
  [`Option (${key}): ${option.label}`, note?.trim()].filter(Boolean).join('\n\n');
