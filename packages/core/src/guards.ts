import { Glob } from 'bun';

/**
 * The security wall. A guard marks a task that touches something no agent may handle on its own:
 * secrets, who has access, publishing, or the project's confidential content. Guards are set by
 * rule (the request's words, the paths the spec predicts and the push changes), never by a model,
 * and only ever grow. Their effects are in `effectivePolicy`, `canAutoVerify`, the plan's merge,
 * the policy context and the board's views.
 */
export const GUARDS = ['secrets', 'access', 'publishing', 'confidential'] as const;
export type Guard = (typeof GUARDS)[number];

export const GUARD_LABELS: Readonly<Record<Guard, string>> = {
  secrets: 'secrets, credentials or environment values',
  access: 'who has access to something',
  publishing: 'publishing, deploying or making something public',
  confidential: "the project's confidential content"
};

/** Guards that always need the owner's approval at both gates, whatever the lane says. */
export const OWNER_GUARDS: ReadonlySet<Guard> = new Set(['secrets', 'access', 'publishing']);

/** Words that mark a request as asking about a guarded subject. Matching only raises the bar. */
const REQUEST_RULES: Readonly<Record<Exclude<Guard, 'confidential'>, RegExp>> = {
  secrets:
    /\b(secrets?|passwords?|credentials?|api[ _-]?keys?|tokens?|private keys?|env(ironment)? (vars?|variables?|values?))\b|\.env\b|\b[A-Z][A-Z0-9]*_(URL|KEY|SECRET|TOKEN|PASSWORD)\b/i,
  access:
    /\b(add|make|set|promote) (me|him|her|them|\w+) (as |an? |to )*(admin|administrator|owner|maintainer|collaborator)\b|\b(admin|owner|root) (access|rights|role|permissions?)\b|\b(give|grant) (me|him|her|them|\w+) (\w+ )?access\b|\b(access|permissions?) (for|to) (me|him|her|them|everyone)\b/i,
  publishing:
    /\b(publish(ed|ing)?|deploy(ed|ing)?|go(es)? live|make (it |this )?public|public(ly| link| url| page)|expose|share (it |this )?(externally|publicly|with (the )?(public|investors|clients|customers)))\b/i
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The guards a request's own words call for, plus the project's confidential terms. */
export const guardsInRequest = (text: string, confidentialTerms: readonly string[]): Guard[] => {
  const found = (Object.keys(REQUEST_RULES) as Exclude<Guard, 'confidential'>[]).filter((guard) =>
    REQUEST_RULES[guard].test(text)
  );
  const terms = confidentialTerms.filter((term) =>
    new RegExp(`\\b${escapeRegExp(term)}`, 'i').test(text)
  );
  return terms.length ? [...found, 'confidential'] : found;
};

export interface GuardPaths {
  /** Files whose content is confidential: agents read them but never quote them outside. */
  readonly confidential: readonly string[];
  /** Files that publish, deploy or open access: any change to them needs the owner. */
  readonly publishing: readonly string[];
}

const matches = (patterns: readonly string[], path: string) =>
  patterns.some((pattern) => new Glob(pattern).match(path));

/** The guards the paths a change predicts or makes call for. */
export const guardsForPaths = (guards: GuardPaths, paths: readonly string[]): Guard[] => [
  ...(paths.some((path) => matches(guards.confidential, path)) ? (['confidential'] as const) : []),
  ...(paths.some((path) => matches(guards.publishing, path)) ? (['publishing'] as const) : [])
];

/** Adds guards to a task's set, in `GUARDS` order; a guard once set stays. */
export const withGuards = (current: readonly Guard[], added: readonly Guard[]): Guard[] =>
  GUARDS.filter((guard) => current.includes(guard) || added.includes(guard));

/** Files that hold secrets. A push that adds or changes one never reaches review. */
const SECRET_FILES = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/*credentials*.json',
  '**/*service-account*.json'
];
/** Templates people commit on purpose, with placeholders instead of values. */
const SECRET_TEMPLATES = /\.(example|sample|template|dist)$/;

export const secretFiles = (paths: readonly string[]): string[] =>
  paths.filter((path) => !SECRET_TEMPLATES.test(path) && matches(SECRET_FILES, path));

const REDACTED = '[redacted: looks like a secret]';

/** Shapes of secrets that must never leave the sandbox in an agent's words. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
];

/** `NAME=value` where the name says it is a secret: the name stays, the value goes. */
const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL|DSN)[A-Z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'`]{6,})/g;

/** A URL with a password in it: the password goes. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi;

/** Removes anything shaped like a secret from text, keeping the rest readable. */
export const redactSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, REDACTED), text)
    .replace(SECRET_ASSIGNMENT, `$1$3${REDACTED}`)
    .replace(URL_PASSWORD, `$1${REDACTED}@`);

/** Redacts every string inside a value, for agent output before anything stores or shows it. */
export const redactDeep = <T>(value: T): T => {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, redactDeep(inner)])
    ) as T;
  return value;
};
