# Reusability catalog

Search here before writing a helper, a type, a component or a fake. When you add a shared piece, add its line here in the same pull request.

## `packages/core`

| Piece                                                                          | Path               | What it is                                                                  |
| ------------------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------------- |
| `STAGES`, `TERMINAL_STAGES`, `AGENT_ROLES`, `REVIEWER_ROLES`                   | `src/lifecycle.ts` | The stage and agent role lists; the DB constraints mirror them              |
| `decide`, `Command`, `DomainEvent`, `Task`, `newTask`, `Actor`, `ENGINE`       | `src/lifecycle.ts` | The state machine; `ENGINE` is Officina itself acting                       |
| `gateSubject`, `effectivePolicy`, `canAutoVerify`                              | `src/lifecycle.ts` | What a gate approves, the policy in force, whether a result may skip people |
| `nextAgentRoles`, `branchForTask`                                              | `src/steps.ts`     | Which agents a task waits on; the only task branch name                     |
| `LANES`, `computeLane`, `stricterLane`, `redPaths`, `compileLaneMatcher`       | `src/lanes.ts`     | Lanes from paths                                                            |
| `ROLES`, `hasRole`, `Member`                                                   | `src/roles.ts`     | Member roles and their order                                                |
| `evaluatePolicy`, `isEligible`, `APPROVAL_FLOOR`                               | `src/policies.ts`  | Whether approvals satisfy a policy, with waivers                            |
| `parseProjectConfig`, `parseProjectConfigYaml`, `ProjectConfig`, `BOARD_LOOKS` | `src/config.ts`    | The project config, validated and normalized                                |
| `OUTPUT_SCHEMAS`, `parseAgentOutput`, `commandForOutput`, `PushFacts`          | `src/contracts.ts` | Role contracts and the command each result maps to                          |

## `packages/db`

| Piece                                                                                                                                                                                                        | Path               | What it is                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------- |
| `applyCommand`, `createTask`, `loadTask`, `setTaskTitle`                                                                                                                                                     | `src/store.ts`     | The transactional task store                   |
| `loadTaskContext`, `startRun`, `finishRun`, `appendRunEvent`, `appendTaskEvent`, `feedbackSinceLastPush`, `githubReviewsSinceLastPush`, `countInterviewQuestions`, `listActiveTaskIds`, `countOpenAgentWork` | `src/runs.ts`      | What the engine reads and records around a run |
| `listBoardTasks`, `loadBoardTask`, `listTaskEvents`, `listTaskRuns`, `listSpecVersions`                                                                                                                      | `src/board.ts`     | Rows the board views are built from            |
| `resolveProjectId`, `resolveProjectMember`, `findTaskIdByNumber`, `addComment`, `listProjectMembers`                                                                                                         | `src/tasks.ts`     | Lookups the API and CLI share                  |
| `upsertWorkspace`, `upsertMember`, `upsertProject`, `setProjectRole`, `findProjectsByRepo`                                                                                                                   | `src/projects.ts`  | Registration                                   |
| `createLoginLink`, `redeemLoginLink`, `createSession`, `memberForSession`, `purgeExpiredCredentials`                                                                                                         | `src/auth.ts`      | Sign-in links and sessions                     |
| `insertLearnings`, `listLearnings`, `loadLearning`, `decideLearning`, `learnerHasLooked`                                                                                                                     | `src/learnings.ts` | Learnings                                      |
| `migrate`                                                                                                                                                                                                    | `src/migrate.ts`   | Applies `migrations/*.sql` once each           |

## `packages/github`, `packages/runner`, `packages/engine`

| Piece                                                                                                                    | Path                                  | What it is                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------- |
| `createGitHubClient`, `GitHubError`, `COMPARE_FILE_LIMIT`                                                                | `packages/github/src/client.ts`       | Every call as the App: tokens, files, branches, pull requests        |
| `createGitHubUserAuth`, `createGitHubAsUser`                                                                             | `packages/github/src/user.ts`         | A member's own GitHub account: approve, merge, ask Copilot to review |
| `verifyWebhookSignature`, `parseWebhookEvent`                                                                            | `packages/github/src/webhooks.ts`     | Webhook intake                                                       |
| `copilotVerdict`, `COPILOT_VERDICTS`, `COPILOT_REVIEWERS`                                                                | `packages/github/src/copilot.ts`      | Who Copilot is and the verdict its review body states                |
| `ManagedAgentsPort`                                                                                                      | `packages/runner/src/port.ts`         | The runner seam                                                      |
| `executeRun`, `MAX_RESULT_ATTEMPTS`, `RUNNER`                                                                            | `packages/runner/src/run.ts`          | One session from brief to validated result; the runner name          |
| `RUNNER_ROLES`, `buildDefinition`, `loadDefinitions`, `RESULT_TOOL`                                                      | `packages/runner/src/definitions.ts`  | Agent definitions                                                    |
| `syncAgents`, `ensureEnvironment`                                                                                        | `packages/runner/src/sync.ts`         | Agents and environments kept in step                                 |
| `createModelResolver`, `PINNED_MODELS`                                                                                   | `packages/runner/src/models.ts`       | The only place model ids live                                        |
| `buildBrief`, `MAX_INTERVIEW_QUESTIONS`                                                                                  | `packages/engine/src/brief.ts`        | What an agent reads; `fence` and `list` for briefs                   |
| `runAgentStep`, `taskLink`                                                                                               | `packages/engine/src/step.ts`         | One step; a Markdown link to a task                                  |
| `openTaskPullRequest`, `openMissingPullRequests`                                                                         | `packages/engine/src/pull-request.ts` | A task's pull request, opened once, and the scheduler's catch-up     |
| `collectDueSteps`, `tick`                                                                                                | `packages/engine/src/tick.ts`         | Dispatch and due work                                                |
| `syncSpecStatus`, `postChecklist`, `approveOnGitHub`, `askCopilotToReview`, `requestCopilotReviews`, `checklistMarkdown` | `packages/engine/src/github-sync.ts`  | Mirroring to GitHub, and acting there as a member (`OnBehalf`)       |

## `apps/api`

| Piece                                                            | Path                                  | What it is                                                                      |
| ---------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `createApp`                                                      | `src/app.ts`                          | The Elysia app, errors and routes wired                                         |
| `createBoardApi`                                                 | `src/api.ts`                          | `/api/*` routes                                                                 |
| `boardView`, `taskView`, `roleLabel`, `roleLabels`, `agentsView` | `src/board.ts`                        | What the board receives, filtered by role; the only place agent roles are named |
| `createRequest`, `actOnTask`, `TaskCommandError`                 | `src/tasks.ts`                        | Task actions shared by the API and the CLI                                      |
| `addProject`, `setupAgents`, `SetupError`                        | `src/setup.ts`                        | Registration and agent sync                                                     |
| `startRealtime`, `startScheduler`                                | `src/realtime.ts`, `src/scheduler.ts` | Server-sent events, the engine loop                                             |
| `createTokenBox`                                                 | `src/token-box.ts`                    | Encrypts stored GitHub tokens                                                   |

## `apps/board`

| Piece                                                                                                                                               | Path                                 | What it is                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| `get`, `post`                                                                                                                                       | `src/lib/api.ts`                     | Every request to the API, with the request header     |
| `since`, `ago`, `duration`, `money`, `dateTime`, `initials`                                                                                         | `src/lib/format.ts`                  | Formatting                                            |
| `STAGE_LABELS`, `COLUMNS`, `TRACK`, `CLOSED`                                                                                                        | `src/lib/stages.ts`                  | Columns and stage words                               |
| `board`, `session`, `look`, `live`, `clock`, `toasts`                                                                                               | `src/lib/state/*.svelte.ts`          | Shared state                                          |
| `ROLE_SHAPES`, `roleShape`, `roleCode`                                                                                                              | `src/lib/components/roles.ts`        | How each agent role is drawn                          |
| `Markdown`                                                                                                                                          | `src/lib/components/Markdown.svelte` | The only way to render agent-written text (sanitized) |
| `AgentAvatar`, `MemberAvatar`, `LaneChip`, `Modal`, `Checklist`, `ApprovalPlan`, `RunLog`, `RunRow`, `Timeline`, `StageTrack`, `TaskCard`, `Toasts` | `src/lib/components`                 | Building blocks of every surface                      |

## Test helpers

| Piece                                                         | Path                                | What it is                                                  |
| ------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `CONFIG_YAML`, `loadConfig`, `createDriver`, members, `PLAN`  | `packages/core/test/fixtures.ts`    | A config and a driver that applies commands like the engine |
| `resetAndSeed`, `applyOrThrow`, `createTaskInMerging`, `PLAN` | `packages/db/test/seed.ts`          | A fresh schema with one workspace, owner and project        |
| `createFakePort`, `toolUse`, `idle`, `running`, `terminated`  | `packages/runner/test/fake-port.ts` | A scripted Managed Agents port                              |
| `with-postgres.ts`                                            | `packages/db/test/with-postgres.ts` | Runs the database tests against a throwaway container       |
