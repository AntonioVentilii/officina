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
