type Payload = Readonly<Record<string, unknown>>;

/**
 * The timeline's sentence for a tier forced on a task, or given back to the rule. Contributors read
 * no tier (`payloadFor` in the API): the model is a detail of the runs, which they do not see.
 */
export const MODEL_SENTENCES: Readonly<Record<string, (payload: Payload) => string>> = {
  model_forced: (payload) =>
    payload.to === undefined
      ? 'changed the model its agents run on'
      : payload.to === null
        ? 'gave the choice of model back to the rule'
        : `forced every agent step onto ${String(payload.to)}`
};
