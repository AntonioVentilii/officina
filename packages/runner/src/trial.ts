import {
  buildDefinition,
  loadDefinitions,
  type AgentDefinition,
  type AgentShape
} from './definitions';
import type { TierModels } from './models';
import type { AgentVersionRef, ManagedAgentsPort } from './port';
import { loadPrompt, loadStandard, withStandard } from './standard';
import { syncByName } from './sync';

/**
 * The two ways a trial runs the same build, to tell whether the reader pays for itself: the
 * builder as production runs it, handing reading to the reader, and the builder reading alone.
 */
export const TRIAL_ARMS = ['reader', 'solo'] as const;
export type TrialArm = (typeof TRIAL_ARMS)[number];

export const isTrialArm = (value: string): value is TrialArm =>
  (TRIAL_ARMS as readonly string[]).includes(value);

/**
 * A trial agent's name, never one production syncs or runs: a trial writes only its own agents,
 * so what production runs stays as it is.
 */
const trialName = (name: string, arm?: TrialArm): string =>
  `${name.replace(/^officina-/, 'officina-trial-')}${arm ? `-${arm}` : ''}`;

const renamed = <T extends AgentShape>(shape: T, name: string): T => ({ ...shape, name });

/**
 * The builder of each arm on the same model and effort: the reader arm is production's builder as
 * `loadDefinitions` makes it, the solo arm the same prompt and standard without the reader or the
 * rules for using it. Trial agents keep the hash of the definition they copy, so one is written
 * again only when that definition changes.
 */
export const trialBuilders = async (
  promptsDir: string,
  models: TierModels
): Promise<Record<TrialArm, AgentDefinition>> => {
  const [definitions, standard, prompt] = await Promise.all([
    loadDefinitions(promptsDir, models),
    loadStandard(),
    loadPrompt(promptsDir, 'builder')
  ]);
  const production = definitions.find((definition) => definition.role === 'builder')!;
  const alone = buildDefinition('builder', withStandard(prompt, standard), models);
  return {
    reader: {
      ...renamed(production, trialName(production.name, 'reader')),
      reader: production.reader && renamed(production.reader, trialName(production.reader.name))
    },
    solo: renamed(alone, trialName(alone.name, 'solo'))
  };
};

/** The trial builder's version to start a session on, written first when it changed, with its reader. */
export const syncTrialBuilder = async (
  port: ManagedAgentsPort,
  definition: AgentDefinition
): Promise<AgentVersionRef> =>
  syncByName(
    port,
    definition,
    definition.reader ? [await syncByName(port, definition.reader)] : []
  );
