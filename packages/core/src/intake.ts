import { can } from './permissions';
import type { Member } from './roles';

type Requester = Pick<Member, 'role'> & Partial<Pick<Member, 'domains'>>;

/**
 * Whether a new request gets the interview when its requester has not said. Someone who may triage
 * requests writes one the spec agent can work from and would send it on anyway, so theirs goes
 * straight to triage; everyone else's is interviewed.
 */
export const interviewsByDefault = (requester: Requester): boolean => !can(requester, 'triage');

/**
 * Whether a new request is interviewed: as its requester asked, or by default when they did not
 * say. A project that turned interviews off (`intake.interview: false`) interviews nobody.
 */
export const interviewsRequest = (
  projectInterviews: boolean,
  requester: Requester,
  asked: boolean | undefined
): boolean => projectInterviews && (asked ?? interviewsByDefault(requester));
