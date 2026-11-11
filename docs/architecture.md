# Officina architecture

Officina is a collaborative software workshop. People describe what they need, agents turn it into specs, code and reviews, and people decide at every point that matters. Developers and non-developers work on the same board, on the same tasks, with the same audit trail.

This document is the source of truth for how Officina works. Anything that contradicts it is a bug in either the code or this page.

## 1. Principles

1. **Collaborative first.** Every surface is multi-user: shared board, task threads, mentions, approvals by policy, notifications, presence. A single-user flow is a special case of a team flow, never the other way round.
2. **Review is the bottleneck, not typing.** Officina optimizes human minutes per merged change. Agent throughput only matters when people can keep up with it.
3. **People decide, agents do.** What gets built (the spec) is always a human decision, and so is checking the result, except for low-risk changes a project explicitly lets through (section 8). Merging is always a person's act: Officina never merges and never turns on auto-merge, and agents never approve their own work.
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

**Identity.** Today a member signs in with a one-time link: an owner mints it with `login-link`, or `invite` adds a person with a role and returns their first link. The token travels in the URL fragment, so it never reaches a server log; only its hash is stored, it works once, and it becomes an `HttpOnly`, `SameSite=Lax` session cookie. A member can also **connect GitHub** (the GitHub App's user authorization, callback `/auth/github/callback`); the account is then an identity for **Sign in with GitHub**, and its tokens are stored encrypted with a key only the server holds. GitHub alone never creates a member. When the member whose approval passes a verification has GitHub connected, the engine, after marking the spec `Implemented`, approves the pull request **as them** at its current head, so the review counts as theirs; it is tried once and recorded as `github_approved` or `github_approval_failed`. It never merges and never turns on auto-merge: once its part is done the engine records `awaiting_merge` and the board shows the pull request as approved and waiting for a person to merge it on GitHub, or `merge_held` when the branch holds commits nobody verified (it moved past the verified head, or a push raced Officina's own status commit), and the board says not to merge until they are reviewed. Without a connected account people approve and merge on GitHub as before. Emailed magic links and Google sign-in come next, for everyone; linking a GitHub account is optional: it only lets Officina submit the verifier's approval on GitHub for them, and merging is always done on GitHub, linked or not. Actions Officina performs on GitHub are done by the Officina GitHub App and name the member who triggered them. A merge approval is submitted with the member's own GitHub user token, so it counts as their code-owner review.

## 3. Collaboration model

- **Workspace -> projects -> tasks.** A workspace is a team (for example one company). A project is one repository plus its config. A task is one request, from first idea to merged change.
- **Requests.** Anyone with contributor rights starts a request in plain language. The interviewer agent asks follow-up questions in the task thread until the request is specific enough to spec. Other members can join the thread, add context or screenshots, and vote. Mechanics: a new request stays in `request` and the interviewer runs; a question becomes an interviewer comment plus a block asked of the requester, whose answer runs it again; at most four questions, then it must finish; finishing posts a summary with "done when" checks, renames the task in the requester's words and submits it to triage. The requester or a maintainer can submit as is at any time, which closes an open question. `intake.interview: false` in the project config, or skipping it per request, goes straight to triage.
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

| Stage         | Worker                               | Enters when               | Leaves when                                                                                    |
| ------------- | ------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `request`     | contributor + interviewer agent      | a member starts a request | the interviewer marks it specific enough, or a maintainer moves it on                          |
| `triage`      | maintainers                          | request is complete       | prioritized -> `speccing`; merged as duplicate; declined with a reason                         |
| `speccing`    | spec agent                           | triaged                   | spec version posted -> `spec_review`; missing fact or decision -> `blocked` with a question    |
| `spec_review` | chooser agent, then people           | spec version posted       | chooser plans the approvals, then policy satisfied -> `ready`; changes -> `speccing`           |
| `ready`       | engine                               | spec approved             | WIP slot free and assignee set -> `building`                                                   |
| `building`    | builder agent or a member            | dispatched or claimed     | branch pushed and checks pass -> `reviewing`; red lane requires a member                       |
| `reviewing`   | reviewer agents (+ optional members) | branch ready              | all reviewers approve -> `choosing`; changes -> `building` fix round (bounded)                 |
| `choosing`    | engine + chooser agent               | reviews approved          | approvals planned, verifiers and checklist assigned -> `verifying`; auto-verified -> `merging` |
| `verifying`   | people, per lane policy              | checklist posted          | policy satisfied -> `merging`; change requests -> `building`                                   |
| `merging`     | code owner                           | verified                  | PR merged -> `done`; CI red -> `building`                                                      |
| `done`        | learner agent (async)                | merged                    | learnings recorded; never blocks the task                                                      |

- **`blocked`** always names a person or a role and a precise question. The first answer in the thread clears it and resumes the stage that blocked.
- **Claims and leases.** A worker (agent run or member) holds a lease on a step. Leases expire; the healer releases stale ones and re-dispatches or notifies.
- **Reviews on GitHub count.** A review left on the pull request for the current head (Copilot's inline comments, or a person asking for changes) sends the task back to building with those comments as notes, from `reviewing` up to `merging`; a person counts only when GitHub reports them as an owner, member or collaborator of the repository, so a stranger on a public repository cannot write the builder's next brief; a review of an earlier head is ignored, except of Officina's own commit that only sets the spec's status line, which counts as the task's head. Officina never turns auto-merge on, but whenever work leaves `merging` (a review, or failing checks) the webhook turns it off in case a person did, and the scheduler retries every pass for any task whose trail still records it as on, until GitHub confirms it (`github_auto_merge_cancelled`); the engine re-reads the task before it approves. Once the fix is reviewed again and verified, the engine resolves the threads of the reviews it forwarded, since branch rules usually require resolved threads. A pull request **closed without being merged** sends its task back to `ready`, unassigned and with no head, held for a maintainer who answers to build it again (the next push opens a new pull request) or cancels it; the task forgets the pull request number except in its timeline.
- **Onboarding comes first.** A project registered without the agent docs its config requires (section 11) gets an **onboarding task** (`kind: onboarding`) before anything else: it starts at `spec_review` with a spec the engine writes, listing what is missing, so people approve it like any other, and it is built by the onboarder instead of the builder. While it is open the engine dispatches no other build in the project: `dispatch` fails with `awaiting_onboarding`, and the board says which task the build waits for. The gate holds only dispatches, so the onboarding task itself is never held by it, and a build already in flight when it opens runs to the end; projects registered before the gate shipped are untouched until `add-project` runs for them again. Merging its pull request lifts the gate, and so does cancelling it, which is a person's decision; registering the project again once every required page is on the default branch cancels the open onboarding task itself. An onboarder run that fails holds the task for a maintainer like any other, who answers to retry or cancels. People can still spec requests meanwhile, and a maintainer can still claim one by hand.
- **Fix rounds are bounded** (default 2 per stage). Past the bound the task is blocked for a maintainer, never looped forever.
- **Nothing skips a human gate it was not configured to skip.** Transitions out of `spec_review` and `verifying` are only accepted from members who satisfy the lane's policy; the only way past `verifying` without one is auto-verify (section 8).

## 6. Agent roles

Each role is a versioned agent definition (system prompt, tools, permission policy, model) stored in this repository under `agents/<role>.md` and applied to the runner. Every run records the role version it used. Every role's system prompt is its own prompt followed by the universal code standard, [`standards/code.md`](../standards/code.md), read in one place (`packages/runner/src/standard.ts`), so the spec writer, the builder, the reviewers and the learner hold the code to the same numbered rules, and a change to the standard becomes a new version of every agent on the next sync. Other repositories link that file and never copy it.

Model ids live in one place, `packages/runner/src/models.ts`, by tier. The Opus tier resolves once per process to the newest `claude-opus-*` the Models API lists (by creation date), falls back to a pinned id when the lookup fails or takes more than 10 seconds, and yields to an explicit `ANTHROPIC_MODEL`; the boot log line `model in use` says which model and why. Effort is set explicitly on every agent, because the default moves between releases. Requests stay within what new Opus releases accept: thinking is never disabled and tool use is never forced (`submit_result` is offered, not required). The engine syncs the role agents on every boot, so a new Opus release or a merged prompt change becomes a new agent version on the next restart; unchanged definitions are left alone. Roles return a JSON contract the engine validates; invalid output fails the run instead of moving the task.

| Role                           | Reads                                                               | Tools                                                       | Returns                                                                                    |
| ------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Interviewer**                | request thread, project product docs                                | read-only repo access                                       | next question, or `complete` with a structured request                                     |
| **Spec**                       | request, thread, project docs and spec template, code               | read-only repo access                                       | spec markdown, predicted file scope, predicted lane, or `blocked` with a question          |
| **Builder**                    | approved spec version, thread, fix notes                            | edit, bash (allowlist), git on `officina/*` branch          | `pushed` with branch and verify results, `failed` with output, or `blocked`                |
| **Reviewer: spec conformance** | spec version, diff                                                  | read-only                                                   | `approve` or numbered `changes` with file:line                                             |
| **Reviewer: correctness**      | diff, the project's agent docs, the code standard                   | read-only                                                   | `approve` or numbered `changes` with file:line and the rule each one breaks                |
| **Chooser**                    | diff, spec, lane result, approval policy                            | read-only                                                   | user-visible or not, verifiers per policy, verification checklist, before/after tables     |
| **Learner**                    | full task history (thread, spec versions, runs, reviews, overrides) | read-only                                                   | 0-3 learnings, each with evidence and a proposed change                                    |
| **Onboarder**                  | the onboarding spec, the code and git history, the required pages   | edit, bash, git on its `officina/*` branch, agent docs only | `pushed` with branch, verify results and follow-ups (smells found), `failed`, or `blocked` |

Builder profiles (`frontend`, `backend`, `infra`, `tests`) are prompt and tool overlays on the builder role, chosen from the spec's file scope.

The builder and the onboarder are the two **build roles** (`BUILD_ROLES` in `packages/core`): each kind of task has one, the engine dispatches it, and only it may push the task branch. The onboarder writes the docs its prompt describes from the code itself, never by copying the standard; a push that changes anything outside the entry document, `CLAUDE.md` and the agent docs folder trips the `outside_agent_docs` guardrail and blocks the task for a maintainer. The smells it finds come back as follow-ups that the engine puts in the pull request body.

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
- **Repository access is scoped by token, not by prompt.** Roles that only read receive an installation token with read-only contents permission, so even a manipulated agent cannot push. Only the build roles (builder, onboarder; `BUILD_ROLES` in `packages/core`) get write access, and only their task branch `officina/task-<number>` is accepted: a push anywhere else fails the step and blocks the task.
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
- **Auto-verify.** A green lane with `auto_verify: true` lets a result go from `choosing` straight to `merging`, recorded as `auto_verified`, only when the project's `release.on_merge` is not `production` and the chooser's plan for the result adds no requirement and asks for no more than a glance. Anything that touches a stricter path is not green, a merge that deploys to production always gets a person's check, and the chooser keeps the human gate by raising the depth or adding an approval. The spec is still approved by people, and a person still merges: the engine records `awaiting_merge` and nothing lands until someone merges the pull request on GitHub.
- **Calibration.** Every chooser verdict is compared with what people did: verified with no changes suggests over-gating, sent back suggests under-gating. The learner uses these outcomes.

## 9. Board surfaces

| Surface       | For                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Board**     | Five columns (requests, plan, building, check, done) in plain words; cards show what each task waits for, whose turn it is, and the lane only when it is not standard. Owners and maintainers also see cost, pull requests and agent runs; everyone else sees only what they need to decide. The API enforces it: agent runs and their logs (which quote the code), costs, and the Agents and Learnings data are served only to owners and maintainers, since contributors and watchers may have no access to the repository. For them the timeline's event payloads keep only what states the decision (`PUBLIC_FIELDS` in `board.ts`), never reviewer notes, changed paths, check output or GitHub error text, and a question they cannot answer shows only that one is open. Everyone sees the request, the spec, what to check, the thread and every decision with who made it |
| **Guide**     | A short welcome shown the first time a member signs in on a browser (remembered per member in local storage) and reopened from Guide in the sidebar: how to make a request, three examples (change a text, report a bug, ask for a feature) that open the request form filled in with a template to complete, what the yellow block means, and how to add the Claude connector with this deployment's `/mcp` address. It lives in the board so it changes with the product                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Inbox**     | Everything waiting on me: approvals, questions, mentions, tool confirmations; one-tap actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Request**   | Conversation with the interviewer, with other members able to join                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Task**      | Thread, spec versions with inline comments, live agent log, diff, reviews, chooser checklist, preview link, cost, timeline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Agents**    | Roles, versions, running sessions, success and rework rates per role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Learnings** | Proposed and accepted learnings with their evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Metrics**   | Human minutes per merged change, lead time, rework rate, cost per change, requests by non-developers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Settings**  | Members and roles, lanes, approval policies, notification channels, runner and budgets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The board has two looks over the same components, set as `data-look` on `<html>` next to `data-theme`: **Modernista** (the default) and **Tecnica**. A member picks one in the sidebar footer and the choice stays in their browser; until they do, the project's `board.look` from its config applies. Each look has its own light and dark tokens in `app.css`, and a component that draws differently per look branches in one place, either in its markup through `look.current` (`state/look.svelte.ts`) or in CSS under `[data-look='tecnica']`, never as a second copy of the component. The looks carry meaning, so keep it when adding surfaces: one yellow (`--accent`) means only "waiting on you", and red (`--danger`) means only an error or a failed run (and, in Tecnica, the sensitive lane's hatching). Agent roles are never told apart by hue: Modernista draws black shapes (`roles.ts`: interviewer circle, spec square, builder triangle, spec reviewer half disc, correctness reviewer quarter disc, chooser diamond, learner ring, onboarder framed square) and Tecnica three-letter codes in a ruled box (INT, SPC, BLD, RVS, RVC, CHS, LRN, ONB). A lane is a circle filled by risk in Modernista (a ring, half, full) and a hatched box in Tecnica (open, vertical ruling, red cross-hatching). Modernista sets Archivo on its width axis, with JetBrains Mono for code only; Tecnica sets IBM Plex Sans Condensed for labels and heads, IBM Plex Sans for what people wrote and IBM Plex Mono for every number and id. Neither uses radii or shadows.

## 10. Auto-learn

1. **Once per merged task** (within 14 days of `done`) the scheduler runs the learner on a read-only token. Its brief is the whole history as data: request, final spec, every event with actor and time (review notes, change requests, questions and answers, guardrails, approval plans), agent runs with cost and duration, the thread, and the learnings already proposed or rejected so it does not repeat them. A failed attempt is recorded and never retried: learning is optional.
2. It proposes **at most three learnings, often none**. Each has a lesson, its evidence, and an **exact edit** to one of three targets (`LEARNING_TARGETS` in `packages/core`): `docs`, the project's agent docs (its entry document and the pages of `docs.standards`, a new page there included, never a tool layer such as `CLAUDE.md`, which only points at the entry), the first place for a lesson about structure, patterns, shared code, testing or pull request rules, since every later agent reads them; `project`, any other Markdown file in the project (never a protected path); or `agent`, an Officina role prompt (`agents/<role>.md`). The edit adds text after an excerpt found exactly once, or appends it. The engine checks every edit applies, and that its file matches its target, before accepting the result, so what people see is what would land.
3. Maintainers **accept or reject** each learning on the board. Accepting a `docs` or `project` learning re-applies the edit to the current default branch, pushes `officina/learning-<id>` and opens a pull request titled `docs(ai): ...` or `docs(learning): ...`; people merge it as usual, and the merge marks the learning applied. Officina never writes to its own repository, so accepted agent learnings stay listed for Officina's maintainers to apply; a merged prompt change becomes a new agent version on the next deploy (or `setup-agents`).
4. Later: a weekly synthesis groups learnings across tasks, so one-off noise does not become policy.

## 11. Project config

Lives in the consumer repository at `.github/officina.yml`. Members and roles are managed in Officina, not in this file.

```yaml
version: 1
docs:
  entry: AGENTS.md # what every agent reads first
  spec_template: docs/specs/template.md
  spec_dir: docs/specs # the engine sets a spec's `Status:` line to In progress / Implemented
  standards: docs/ai # the agent docs folder (the default); its pages default to DEFAULT_STANDARDS_PAGES
  pages: [README.md, structure.md, reusability.md] # only when a project needs other pages, relative to the folder
  catalogs: # a file added under the glob must be listed on the page, relative to the docs folder
    'src/lib/components/**': reusability.md
pull_request:
  title_pattern: '^(feat|fix|docs|chore)\([a-z-]+\): .+$' # the builder's PR title must match
verify: ['npm ci', 'npm run lint', 'npm run check'] # run by the builder before pushing
release:
  on_merge: staging # what merging into the default branch deploys: production (the default), staging or nothing
board:
  look: tecnica # the board's look until a member picks their own: modernista (the default) or tecnica
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
    auto_verify: true # green only: results skip a person's check when nothing calls for one; a person still merges (section 8)
    wip: 5
    budget_usd: 5
    approvals:
      spec_review: [{ requester: true }, { domain: product }]
      verifying: [{ requester: true }]
```

**Agent docs.** Every project follows the universal code standard ([`standards/code.md`](https://github.com/AntonioVentilii/officina/blob/main/standards/code.md)) and holds its own agent docs: the `docs.entry` document plus the pages of `docs.standards`, read off the code (structure, patterns, the catalog of shared code, testing, pull request conventions). `requiredDocs` in `packages/core/src/config.ts` is the one list of what a project must hold: the entry, every page and every catalog page. The correctness reviewer holds each change to the project's pages and the standard and cites the rule each item breaks (`rule` in its contract), and every catalog is checked mechanically after each build round (section 13). Registering a project (`add-project`) checks each of them on the default branch through the GitHub App; when any is missing it opens the onboarding task (section 5) that writes them, at most one open at a time.

## 12. Data model

| Table                                 | Holds                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `workspaces`, `members`, `identities` | teams, people, linked email / Google / GitHub identities                                  |
| `projects`, `project_roles`           | repositories, config snapshot, per-project roles and approval domains                     |
| `tasks`                               | kind (request or onboarding), stage, flags, lane, priority, assignee, linked issue and PR |
| `task_events`                         | append-only audit: actor (member or agent role + version), type, payload, timestamp       |
| `comments`, `mentions`, `attachments` | task threads; comments may anchor to a spec version and section                           |
| `spec_versions`                       | immutable spec documents per task                                                         |
| `approvals`                           | member, gate, spec version or head commit, decision, note                                 |
| `leases`                              | step, holder, expiry                                                                      |
| `runs`, `run_events`                  | runner, session id, role version, status, cost, tokens, normalized event stream           |
| `votes`, `notifications`, `learnings` | as named                                                                                  |

## 13. Security model

- **Agents act only on dispatch from the engine**, never directly on issue text or comments from the outside world. Public issue text is data: it reaches prompts inside a quoted block labelled as untrusted.
- **Least privilege per role.** Read-only roles have no write tools. The engine accepts only the task's own `officina/*` branch as a builder's result. The installation token it hands the builder can still write any ref the App can reach, so the engine snapshots the default branch head and every tag before and after each build run: a tag created, moved or deleted, or a default branch move that is not a pull request merged on top of the old head, fails the run, discards its result and blocks the task with a question for a maintainer. That check finds a push after the fact; it does not prevent one, so a project must still protect its default branch and tags with a ruleset the App cannot bypass. No role can merge, change branch rules, touch CI secrets or deploy; the token never carries the `workflows` permission.
- **Approvals are pinned to what was verified.** Approving on GitHub as the verifier names the expected head: the task's verified head, or Officina's own spec status commit on top of it. A status commit counts only when its parent is that head; on a branch that moved, none is written. A pull request whose head is anything else is not approved; the mismatch is recorded on the task.
- **People act within their role.** Watchers read; they cannot open requests (each one starts paid agent runs), comment, or answer questions. An answer's comment is written in the same transaction as the decision, so a refused answer leaves nothing behind.
- **Webhooks apply once.** A delivery id is claimed atomically before processing and given back if processing fails, so concurrent redeliveries are never applied twice and a failed one is retried.
- **Credentials do not pile up.** Starting a GitHub sign-in writes nothing: its state carries its own expiry, is bound to the browser by a cookie, and is spent atomically once GitHub accepts the code, before the account is written, so it works once. The scheduler purges expired or spent sign-in links, sessions and authorization states hourly.
- **Errors stay on the server.** An unexpected error is logged and answered with `{"error":"internal"}`, since its message can quote a GitHub response or a query; a malformed path is a 400.
- **Mechanical guardrails after every build round:** red-lane paths, diff size and, for the onboarder, paths outside the agent docs are checked by the engine; a hit blocks the task instead of opening a PR.
- **The catalog check runs after every build round too**, from the real diff like the lane: a file the branch adds (new, copied or renamed to a new path) under a `docs.catalogs` glob that the catalog page, read as pushed, does not name (by its path or its file name) is a finding (`unlisted_files`, `unlistedFiles` in `packages/core/src/catalogs.ts`); an edit to the page that says nothing about the file does not count. It sends the work straight back to the builder with the finding as a note, keeping the head, as one more bounded fix round, so a shared file nobody listed never reaches the reviewers. It holds for a person building the task as much as for an agent.
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
- **Humans merge.** A verified result is approved on GitHub as the member who verified it; every result, verified or auto-verified, is merged by a person on GitHub. Officina has no merge path at all, so no setting can make a pull request merge by itself.

## 16. Open questions

1. Does a GitHub App installation token work as the `github_repository` `authorization_token` (it expires after an hour; sessions support rotating it)?
2. Which session events should be persisted in full versus summarized, given board needs and storage growth?
3. Preview environments: generic contract (a PR comment or deployment status the chooser reads) or runner-managed?
