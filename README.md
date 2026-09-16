# Officina

A collaborative software workshop. Anyone on the team describes what they need; agents write the spec, build the change and review it; people approve, verify and merge. Developers and non-developers work on one shared board with one audit trail.

**Status:** design phase. Nothing is runnable yet.

## How it works

1. A member starts a request in plain language. An interviewer agent asks follow-up questions until it is specific.
2. Maintainers triage it. A spec agent writes a spec; the right people review and approve it, per lane policy.
3. A builder (an agent, or a member who claims the task) pushes a branch. Two reviewer agents check it against the spec and for correctness.
4. A chooser decides who must verify it and what exactly to check. Those people verify; a code owner merges.
5. A learner turns what went wrong into proposed improvements, delivered as pull requests.

Risk lanes, computed from the paths a change touches, decide what agents may do and whose approval is needed.

## Docs

- [Architecture](./docs/architecture.md): principles, roles, lifecycle, agents, runner, data model, security, phases.
- [AGENTS.md](./AGENTS.md): entry point for agents working on this repository.

## License

[MIT](./LICENSE)
