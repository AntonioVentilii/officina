import type { ConfigResult } from './config';
import { can } from './permissions';
import type { Member } from './roles';

type Requester = Pick<Member, 'role'> & Partial<Pick<Member, 'domains'>>;

/**
 * Whether the project interviews requests at all (`intake.interview`). A config that does not
 * parse keeps the default, so a broken config never silently drops the interview.
 */
export const projectInterviews = (config: ConfigResult): boolean =>
  !config.ok || config.config.intake.interview;

/**
 * Whether a new request gets the interview when its requester has not said. Someone who may triage
 * requests writes one the spec agent can work from and would send it on anyway, so theirs goes
 * straight to triage; everyone else's is interviewed.
 */
export const interviewsByDefault = (requester: Requester): boolean => !can(requester, 'triage');

/**
 * What a new request form offers this requester: the interview's default for them, or `null` in a
 * project that interviews nobody, where there is nothing to choose.
 */
export const interviewOffer = (config: ConfigResult, requester: Requester): boolean | null =>
  projectInterviews(config) ? interviewsByDefault(requester) : null;

/**
 * Whether a new request is interviewed: as its requester asked, or by default when they did not
 * say. A project that turned interviews off interviews nobody.
 */
export const interviewsRequest = (
  config: ConfigResult,
  requester: Requester,
  asked: boolean | undefined
): boolean => projectInterviews(config) && (asked ?? interviewsByDefault(requester));
