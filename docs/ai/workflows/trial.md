# Measure a way of running an agent on past tasks

History: `feat(runner,engine,api): replay a past build on its own trial agents to measure what the reader saves`.

A trial replays the first build of a past task on the commit it started from, once per arm, and prints what each run cost and read. Today it compares the builder as production runs it (`reader`, handing reading to the reader) with the same builder reading alone (`solo`).

1. Pick tasks with a known outcome: their spec is stored, and the board's runs (`/api/projects/:id/runs`) give the original build's cost. The base is the default branch's head when that build started: the parent of the task branch's first commit, or `git rev-list -1 --first-parent --before=<started at> origin/main`.
2. `scripts/officina trial-build --number <n> --base <full sha> --arm reader --budget-usd <cap>` prints the plan and the brief and spends nothing. Read the brief before going on.
3. Add `--run`. It is refused while a build of the project is running (its ref check would count the trial's push), and on a branch an earlier attempt already pushed (`--attempt <a>` gives the next its own). Both arms run at the model and effort a first build of the task gets today (`firstBuildChoice`, the step's own `chooseModel` with nothing pushed yet). It writes only trial agents (`officina-trial-*`, from `trialBuilders` in `packages/runner/src/trial.ts`) and pushes only `officina/trial-task-<n>-<arm>-<a>`; nothing reaches the board, the task or its runs. The session spends real money, capped by `--budget-usd`: ask the owner first, with the estimate.
4. The report has the session's list cost and tokens, each thread's requests and largest prompt, the questions handed to the reader and the files the builder read again after an answer named them (`measureSession` in `packages/runner/src/measure.ts`). `trial-measure --session <id>` gives the same for any finished session, such as the original build, at no cost.
5. Check the pushed branch yourself: the verify commands, and the diff against the change that merged. Delete the trial branches when done.

A new arm (another role, another model) is a new entry in `TRIAL_ARMS` with its definition in `trialBuilders`; the rest stays as it is.
