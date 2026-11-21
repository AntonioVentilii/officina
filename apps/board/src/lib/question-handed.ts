type Payload = Readonly<Record<string, unknown>>;

/** The timeline's sentence for a waiting question an owner handed to one member. */
export const QUESTION_SENTENCES: Readonly<Record<string, (payload: Payload) => string>> = {
  question_handed: (payload) =>
    typeof payload.memberName === 'string'
      ? `handed the question to ${payload.memberName}`
      : 'handed the question to another member'
};
