# Officina architecture

Officina is a collaborative software workshop. People describe what they need, agents turn it into specs, code and reviews, and people decide at every point that matters. Developers and non-developers work on the same board, on the same tasks, with the same audit trail.

This document is the source of truth for how Officina works. Anything that contradicts it is a bug in either the code or this page.

## 1. Principles

1. **Collaborative first.** Every surface is multi-user: shared board, task threads, mentions, approvals by policy, notifications, presence. A single-user flow is a special case of a team flow, never the other way round.
2. **Review is the bottleneck, not typing.** Officina optimizes human minutes per merged change. Agent throughput only matters when people can keep up with it.
3. **People decide, agents do.** Specs, verification and merges are human decisions. Agents never merge, and they never approve their own work.
4. **The engine is deterministic.** State transitions, scheduling, claims, retries, limits and stuck-work detection are plain code. Models run only inside stage agents, and their output is a typed contract the engine validates.
5. **Risk is mechanical.** Which lane a change belongs to is decided by path rules on the actual diff, not by a model's opinion. Lanes decide which approvals are needed.
6. **Humans and agents are interchangeable workers.** Any build or review step can be assigned to an agent or claimed by a person, and handed back and forth.
7. **Code lives in GitHub.** Officina never replaces the repository, its CI or its branch rules. It opens branches and PRs through its GitHub App and mirrors progress back to issues.
8. **Everything is attributed.** Every event records a human member or an agent role at a specific version.
9. **Consumer-agnostic.** Nothing project-specific lives in Officina. A project brings a config file and its own docs.
10. **Agent-legible.** Officina's own docs are written for agents as first-class readers, and Officina is built with Officina as soon as it can be.

## 2. People and roles

Roles are per project and live in Officina, never in repository permissions. A member only needs a GitHub account to merge.

| Role            | Can                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **Owner**       | everything; edits project config, lanes and approval policies; manages members                      |
| **Maintainer**  | triage, approve specs and verifications per policy, claim build or review work, merge if code owner |
| **Contributor** | file requests, take part in the interview, comment, vote, verify their own requests                 |
| **Approver**    | a contributor tagged with an approval domain (for example `product`, `design`, `legal`)             |
| **Watcher**     | read the board and threads, comment                                                                 |

**Identity.** Today a member signs in with a one-time link: an owner mints it with `login-link`, or `invite` adds a person with a role and returns their first link. The token travels in the URL fragment, so it never reaches a server log; only its hash is stored, it works once, and it becomes an `HttpOnly`, `SameSite=Lax` session cookie. Emailed magic links and Google sign-in come next, for everyone; linking a GitHub account is optional and only required for merging. Actions Officina performs on GitHub are done by the Officina GitHub App and name the member who triggered them. A merge approval is submitted with the member's own GitHub user token, so it counts as their code-owner review.

## 3. Collaboration model

- **Workspace -> projects -> tasks.** A workspace is a team (for example one company). A project is one repository plus its config. A task is one request, from first idea to merged change.
- **Requests.** Anyone with contributor rights starts a request in plain language. The interviewer agent asks follow-up questions in the task thread until the request is specific enough to spec. Other members can join the thread, add context or screenshots, and vote.
- **Triage.** Maintainers see new requests in a triage column: merge duplicates, set priority, move to speccing, or decline with a reason. Votes inform priority, they never decide it.
- **Threads.** Every task has one thread: comments, @mentions, attachments, agent messages and system events in one timeline. Agents read the thread as data, never as instructions.
- **Spec review.** Specs are versioned documents with inline comments and suggested edits. The spec agent revises the spec from the comments; approvals always refer to a specific spec version.
- **Approval policies.** Each lane defines who must approve each human gate, as roles or approval domains with a quorum (for example "requester AND one `product` approver"). Policies are config, not code. Two rules hold whatever a policy says: a requirement that no current member can meet (for example a `product` approver when nobody holds that domain) is **waived and recorded as waived**, so a one-person project is never stuck and a new member's requirements switch on the moment they join; and every gate always needs **at least one maintainer or owner**, a floor that is never waived. One member's approval satisfies every requirement they are eligible for.
- **Assignment.** Build and review steps have an assignee: an agent role, or a member who claims it. A member can take over from an agent mid-task (the branch and the thread carry the context) and hand back.
- **Notifications.** In-app inbox for everything that needs a person: approvals, questions, mentions, tool-call confirmations. Delivery by email and web push; chat integrations later. Each member picks their channels.
- **Presence.** The board and task pages are real-time for everyone viewing them: who is looking, who is typing, which agent is running.
- **GitHub mirror.** Each task has a linked issue; stage changes and decisions are mirrored there as short comments, so the trail is visible to people who never open Officina. Commands in issue comments (`/approve`, `/changes`) are accepted from linked members and follow the same policies.

## 4. System overview

```
  Board (SvelteKit PWA) <--- Server-sent events -----+
        |  HTTPS                                      |
        v                                             |
  API (Bun + Elysia) ---- Engine (deterministic) ---- Postgres (state, events, audit)
        ^                    |          |
        |                    |          +--> Notifier (email, push)
  GitHub App webhooks        |
        |                    v
  GitHub (repo, PRs, CI) <-- Runner interface
        ^                    |
        |                    +--> Managed Agents (primary): versioned role agents,
        |                    |    sandboxed sessions, event stream, budgets
        +--- git proxy ------+--> GitHub Actions + Agent SDK (fallback)
                             +--> self-hosted worker (later)
```

| Component    | Responsibility                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Board**    | Every human surface (section 9). Installable PWA so approvals work from a phone.                                                         |
| **API**      | Auth, members, tasks, threads, approvals, config; webhook intake from GitHub and from the runner.                                        |
| **Engine**   | State machine, scheduler (priorities, WIP limits), dispatcher (starts runs), claim and lease handling, healer sweeps, policy evaluation. |
| **Postgres** | Single source of orchestration state; append-only `task_events` is the audit log. `LISTEN/NOTIFY` feeds the realtime channel.            |

**Realtime.** Triggers on tasks, task events, comments, runs and run events call `pg_notify`, so every writer (engine, CLI, webhooks, API) reaches open boards without knowing about them. The API holds one `LISTEN` connection and fans changes out over server-sent events, filtered to the projects each viewer belongs to. Events only say what changed; the board refetches, so a missed event costs a refresh, never a wrong state. Server-sent events rather than WebSocket: the board only listens, and every action is an ordinary authenticated `POST`.
| **Runner** | Executes one agent role for one task step and streams events back. Pluggable (section 7). |
| **GitHub App** | Installed per repository: reads code, pushes `officina/*` branches, opens PRs, mirrors comments, receives webhooks. |

Stack: Bun, Elysia, Postgres (raw `pg`), SvelteKit with Svelte 5 for the board, deployed on Fly.io. One boring stack; deviations need a reason.

## 5. Task lifecycle

Stages are columns on the board. Flags (`blocked`, `paused`) overlay any stage.

| Stage         | Worker                               | Enters when               | Leaves when                                                                                 |
| ------------- | ------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| `request`     | contributor + interviewer agent      | a member starts a request | the interviewer marks it specific enough, or a maintainer moves it on                       |
| `triage`      | maintainers                          | request is complete       | prioritized -> `speccing`; merged as duplicate; declined with a reason                      |
| `speccing`    | spec agent                           | triaged                   | spec version posted -> `spec_review`; missing fact or decision -> `blocked` with a question |
| `spec_review` | chooser agent, then people           | spec version posted       | chooser plans the approvals, then policy satisfied -> `ready`; changes -> `speccing`        |
| `ready`       | engine                               | spec approved             | WIP slot free and assignee set -> `building`                                                |
| `building`    | builder agent or a member            | dispatched or claimed     | branch pushed and checks pass -> `reviewing`; red lane requires a member                    |
| `reviewing`   | reviewer agents (+ optional members) | branch ready              | all reviewers approve -> `choosing`; changes -> `building` fix round (bounded)              |
| `choosing`    | engine + chooser agent               | reviews approved          | approvals planned, verifiers and checklist assigned -> `verifying`                          |
| `verifying`   | people, per lane policy              | checklist posted          | policy satisfied -> `merging`; change requests -> `building`                                |
| `merging`     | code owner                           | verified                  | PR merged -> `done`; CI red -> `building`                                                   |
| `done`        | learner agent (async)                | merged                    | learnings recorded; never blocks the task                                                   |

- **`blocked`** always names a person or a role and a precise question. The first answer in the thread clears it and resumes the stage that blocked.
- **Claims and leases.** A worker (agent run or member) holds a lease on a step. Leases expire; the healer releases stale ones and re-dispatches or notifies.
- **Fix rounds are bounded** (default 2 per stage). Past the bound the task is blocked for a maintainer, never looped forever.
- **Nothing skips a human gate.** Transitions out of `spec_review`, `verifying` and `merging` are only accepted from members who satisfy the lane's policy.

## 6. Agent roles

Each role is a versioned agent definition (system prompt, tools, permission policy, model) stored in this repository under `agents/<role>.yaml` and applied to the runner. Every run records the role version it used. Roles return a JSON contract the engine validates; invalid output fails the run instead of moving the task.

| Role                           | Reads                                                               | Tools                                              | Returns                                                                                |
| ------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Interviewer**                | request thread, project product docs                                | read-only repo access                              | next question, or `complete` with a structured request                                 |
| **Spec**                       | request, thread, project docs and spec template, code               | read-only repo access                              | spec markdown, predicted file scope, predicted lane, or `blocked` with a question      |
| **Builder**                    | approved spec version, thread, fix notes                            | edit, bash (allowlist), git on `officina/*` branch | `pushed` with branch and verify results, `failed` with output, or `blocked`            |
| **Reviewer: spec conformance** | spec version, diff                                                  | read-only                                          | `approve` or numbered `changes` with file:line                                         |
| **Reviewer: correctness**      | diff, project conventions                                           | read-only                                          | `approve` or numbered `changes` with file:line                                         |
| **Chooser**                    | diff, spec, lane result, approval policy                            | read-only                                          | user-visible or not, verifiers per policy, verification checklist, before/after tables |
| **Learner**                    | full task history (thread, spec versions, runs, reviews, overrides) | read-only                                          | 0-3 learnings, each with evidence and a proposed change                                |

Builder profiles (`frontend`, `backend`, `infra`, `tests`) are prompt and tool overlays on the builder role, chosen from the spec's file scope.

## 7. Runner

The runner interface is small: `start(role, task, step) -> run`, a stream of normalized `run_events`, `cancel(run)`, and a final typed result.

### Managed Agents (primary)

| Officina concept               | Managed Agents object               | Notes                                                                                                |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Agent role at a version        | Agent (versioned)                   | `agents/<role>.yaml` applied once per change; runs pin `{id, version}`                               |
| Project build environment      | Environment                         | `limited` networking with package managers allowed; extra hosts listed per project                   |
| One step of one task           | Session                             | `github_repository` resource checked out at the task branch; `initial_events` carries the step input |
| Live log on the board          | Session event stream                | normalized into `run_events`; webhooks for state changes                                             |
| Cost per step and per task     | `usage.list_cost`, session `budget` | budget per step comes from the lane config; a paused-at-budget session asks a maintainer             |
| Risky tool call needs a person | `always_ask` permission policy      | surfaces in the inbox as a confirmation request                                                      |

- **Secrets never enter the sandbox.** Git access goes through the Anthropic-side git proxy, which injects the repository token after the request leaves the container. Other credentials use vault `environment_variable` entries limited to specific hosts.
- **Results come through one tool.** Every role ends by calling a custom `submit_result` tool whose input schema is generated from the role's output contract. The engine validates the call; an invalid result goes back to the agent with the problems listed, and a third invalid result fails the run.
- **Repository access is scoped by token, not by prompt.** Roles that only read receive an installation token with read-only contents permission, so even a manipulated agent cannot push. Only the builder gets write access, and only its task branch `officina/task-<number>` is accepted: a push anywhere else fails the step and blocks the task.
- **Stale results are discarded.** A result is applied only if the task is still in the state the agent worked on (same stage, spec version and head commit, not blocked or paused), checked on the locked row. Parallel reviewers therefore do not conflict, while a result for work that people changed meanwhile is dropped.
- **One active run per task and role**, enforced by a unique index, so overlapping scheduler passes never start the same work twice.
- **The agent pushes a branch; Officina opens the PR** with its GitHub App after the engine's own checks, so the sandbox never needs PR permissions.
- **Beta.** Managed Agents is in beta, which is why the runner is an interface.

### GitHub Actions + Claude Agent SDK (fallback)

A `workflow_dispatch` workflow in the consumer repository runs the Agent SDK with the role definition. It authenticates to Claude with workload identity federation and to Officina with the job's OIDC token. Trade-off: on public repositories Actions logs are public, so agent output must go to Officina, not the log.

## 8. Lanes, the chooser and approval policies

- A project config lists path globs per lane. The spec agent predicts a lane from the file scope; the engine recomputes it from the real diff after every build round. **The stricter lane wins**, and only an owner can lower it, with a reason recorded in the thread.
- Each lane defines: whether agents may build, WIP limit, diff-size limit, per-step budget, and the approval policy for `spec_review`, `verifying` and merge.
- The **chooser** does the judgement a glob cannot: is the change user-visible, which approval domains apply, which specific members are the best verifiers (requester, area owners, recent editors), how deep the check should be, and what exactly to look at. For text-only changes it produces before/after tables so verifiers never read a diff.
- **Approval plans.** The chooser runs at both human gates: on each spec version before anyone may approve it (approving an unplanned version fails with `not_planned`), and on each pushed head before verification. Its plan holds a check depth (`glance`, `test`, `device`), a rationale people read, named verifiers (a request, not a requirement) and extra requirements: domain approvals or the owner role. The effective policy for a gate is the lane policy plus those extras. Plans only ever add: extras accumulate across every plan for the same gate, verifiers must be contributors, and only a maintainer may mark a change as not user-visible. A domain nobody holds is waived like any other requirement, so a plan can raise the bar but never deadlock a small team. Each plan is recorded as an `approval_planned` event with what it added.
- **Calibration.** Every chooser verdict is compared with what people did: verified with no changes suggests over-gating, sent back suggests under-gating. The learner uses these outcomes.

## 9. Board surfaces

| Surface       | For                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Board**     | Columns per stage; cards show lane, assignee (member or agent), elapsed time, cost, blocked and unread badges; filters per project and member |
| **Inbox**     | Everything waiting on me: approvals, questions, mentions, tool confirmations; one-tap actions                                                 |
| **Request**   | Conversation with the interviewer, with other members able to join                                                                            |
| **Task**      | Thread, spec versions with inline comments, live agent log, diff, reviews, chooser checklist, preview link, cost, timeline                    |
| **Agents**    | Roles, versions, running sessions, success and rework rates per role                                                                          |
| **Learnings** | Proposed and accepted learnings with their evidence                                                                                           |
| **Metrics**   | Human minutes per merged change, lead time, rework rate, cost per change, requests by non-developers                                          |
| **Settings**  | Members and roles, lanes, approval policies, notification channels, runner and budgets                                                        |

## 10. Auto-learn

1. After each merged task the learner reviews the full history and proposes up to three learnings, each tied to evidence (review rounds, blocked questions, human overrides, stuck time).
2. A weekly synthesis groups learnings across tasks, so one-off noise does not become policy.
3. Accepted learnings become **pull requests**: to the consumer project's docs (conventions agents should follow) or to this repository's `agents/*.yaml` (role behaviour). People merge them like any other change; a merged role change produces a new agent version.

## 11. Project config

Lives in the consumer repository at `.github/officina.yml`. Members and roles are managed in Officina, not in this file.

```yaml
version: 1
docs:
  entry: AGENTS.md # what every agent reads first
  spec_template: docs/specs/template.md
  spec_dir: docs/specs # the engine sets a spec's `Status:` line to In progress / Implemented
pull_request:
  title_pattern: '^(feat|fix|docs|chore)\([a-z-]+\): .+$' # the builder's PR title must match
verify: ['npm ci', 'npm run lint', 'npm run check'] # run by the builder before pushing
lanes:
  red:
    paths: ['.github/**', 'src/payments/**']
    agents_build: false
    approvals:
      spec_review: [{ role: owner }]
  standard:
    paths: ['**'] # everything not matched by a stricter lane
    wip: 3
    diff_lines: 800
    budget_usd: 25
    approvals:
      spec_review: [{ role: maintainer }]
      verifying: [{ domain: product, when: user_visible }, { role: maintainer }]
  green:
    paths: ['src/i18n/**']
    wip: 5
    budget_usd: 5
    approvals:
      spec_review: [{ requester: true }, { domain: product }]
      verifying: [{ requester: true }]
```

## 12. Data model

| Table                                 | Holds                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `workspaces`, `members`, `identities` | teams, people, linked email / Google / GitHub identities                            |
| `projects`, `project_roles`           | repositories, config snapshot, per-project roles and approval domains               |
| `tasks`                               | stage, flags, lane, priority, assignee, linked issue and PR                         |
| `task_events`                         | append-only audit: actor (member or agent role + version), type, payload, timestamp |
| `comments`, `mentions`, `attachments` | task threads; comments may anchor to a spec version and section                     |
| `spec_versions`                       | immutable spec documents per task                                                   |
| `approvals`                           | member, gate, spec version or head commit, decision, note                           |
| `leases`                              | step, holder, expiry                                                                |
| `runs`, `run_events`                  | runner, session id, role version, status, cost, tokens, normalized event stream     |
| `votes`, `notifications`, `learnings` | as named                                                                            |

## 13. Security model

- **Agents act only on dispatch from the engine**, never directly on issue text or comments from the outside world. Public issue text is data: it reaches prompts inside a quoted block labelled as untrusted.
- **Least privilege per role.** Read-only roles have no write tools. The builder can push only `officina/*` branches. No role can merge, change branch rules, touch CI secrets or deploy.
- **Mechanical guardrails after every build round:** red-lane paths and diff size are checked by the engine; a hit blocks the task instead of opening a PR.
- **Credentials stay outside sandboxes** (git proxy and vault on Managed Agents; OIDC on the fallback runner). Officina's own secrets live in the deployment's secret store.
- **Branch protection remains the final authority.** Officina assumes the repository requires human review and passing CI, and never works around it.
- **Tool calls that need a person** use `always_ask` and route to the inbox; unattended safety evaluation is not treated as a human checkpoint.

## 14. Phases

| Phase | Scope                                                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Engine and state machine, GitHub App, Managed Agents runner, spec / builder / two reviewers / chooser / learner roles, board with columns, task page, threads, approvals, inbox; email sign-in; one project dry run with three tasks, one per lane |
| **1** | Interviewer and request flow, spec inline comments and suggestions, live agent log, notifications (email, push), healer, per-PR preview links, metrics                                                                                             |
| **2** | Multiple projects per workspace, triage voting, learner PRs and weekly synthesis, fallback runner, Google sign-in, chat integrations                                                                                                               |
| **3** | Public release: install docs, hosted option evaluation, self-hosted worker runner                                                                                                                                                                  |

## 15. Decisions

- **Postgres holds orchestration state; GitHub holds code and the public trail.** Labels and comments cannot carry leases, queues, costs, spec versions or live events.
- **Deterministic engine over an LLM orchestrator.** A looping model session is the least reliable place for scheduling and recovery.
- **Managed Agents as the primary runner** for sandboxing with credentials outside the container, versioned roles, event streaming and hard budgets; behind an interface because it is in beta.
- **Roles in Officina, not repository permissions**, so non-developers can collaborate without write access to code.
- **Humans always merge**, and merge approvals are submitted as the member's own GitHub review.

## 16. Open questions

1. Does a GitHub App installation token work as the `github_repository` `authorization_token` (it expires after an hour; sessions support rotating it)?
2. Which session events should be persisted in full versus summarized, given board needs and storage growth?
3. Preview environments: generic contract (a PR comment or deployment status the chooser reads) or runner-managed?
