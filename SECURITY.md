# Security policy

Officina runs agents that can push code to real repositories, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/AntonioVentilii/officina/security/advisories/new) with:

- what an attacker can do, and what they need first (an account, a role, a GitHub review, a crafted request);
- the steps or a proof of concept;
- the commit you tested.

You will get an answer within a few days. Please give a reasonable time to fix the issue before disclosing it.

## Scope

In scope: this repository's code, the default configuration it ships, and anything that lets someone outside a project's members steer an agent, read a project they do not belong to, or get a token or a merge they should not have.

Out of scope: a deployment's own settings (for example a target repository without branch protection), and findings that need control of the server or its secret store.

## Design

The security model is described in [section 13 of the architecture](./docs/architecture.md#13-security-model). In short: agents act only on dispatch from the engine and read outside text as data; tokens are short-lived and scoped to one repository and a role's permissions; production holds no Anthropic API key; and the target repository's branch rules stay the final authority.

## Published advisories

Each advisory names the versions it affects and the first version with the fix. A version marked not released yet is the next one; this table is updated when it is cut.

| Advisory                                                                                                                                                                                  | Severity | Fixed in                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------ |
| [GHSA-qfch-5xxp-wfxv](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-qfch-5xxp-wfxv): open redirect after GitHub sign-in                                            | medium   | 1.6.1                    |
| [GHSA-p2r8-jw4x-w24r](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-p2r8-jw4x-w24r): request bodies limited only by the runtime default                            | medium   | 1.6.1                    |
| [GHSA-xxg8-w2mg-qc2f](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-xxg8-w2mg-qc2f): connecting another member's GitHub account                                    | high     | 1.7.0                    |
| [GHSA-rqj3-6jqm-476p](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-rqj3-6jqm-476p): a sign-in link for a member of projects the owner does not own                | high     | 1.7.0                    |
| [GHSA-779q-w7x4-wwhh](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-779q-w7x4-wwhh): arbitrary text shown as an error on sign-in and connector pages               | low      | 1.7.0                    |
| [GHSA-w7rq-35p8-jh22](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-w7rq-35p8-jh22): accepting a learning with an edit the approver never saw                      | low      | 1.7.0                    |
| [GHSA-3jj8-cr24-j986](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-3jj8-cr24-j986): agent results without size limits                                             | low      | 1.7.0                    |
| [GHSA-gxmp-8mfp-rjc8](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-gxmp-8mfp-rjc8): connector errors sent to unverified addresses, apps that could not be revoked | medium   | 1.7.1 (not released yet) |
| [GHSA-mmm4-72xr-98x4](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-mmm4-72xr-98x4): confidential tasks read and written by members who may not read them          | medium   | 1.7.1 (not released yet) |
| [GHSA-xcr8-w6q4-285c](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-xcr8-w6q4-285c): guarded asks made after the request skipping the owner                        | medium   | 1.7.1 (not released yet) |
| [GHSA-72wc-8h2c-x2qj](https://github.com/AntonioVentilii/officina/security/advisories/GHSA-72wc-8h2c-x2qj): a build's write token outliving its run, other branches unchecked             | medium   | 1.7.1 (not released yet) |
