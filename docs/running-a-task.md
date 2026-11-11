# Running a task

How to take a change from request to merged pull request with Officina, today. Every command runs on
the deployed server through `scripts/officina`, from a clone of this repository, with `fly` logged
in. Commands act as the project owner unless you pass `--as <email>`.

## The board

Everything below can also be done on the board at the public URL. Get a sign-in link (valid 30
minutes, works once):

```bash
scripts/officina login-link
```

The first time someone signs in, the board shows a short guide: how to make a request, three examples to start from, what the yellow block means and how to add Officina to Claude. **Guide** in the sidebar opens it again.

To bring someone in, give them a role and send them the link it prints (valid 7 days):

```bash
scripts/officina invite --email gio@example.com --name "Gio" --role contributor --domains product
```

## The flow at a glance

| You run                            | Then what happens                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `task create`                      | The interviewer asks follow-up questions (`task answer`), then the request waits in triage. `--skip-interview` goes straight there. |
| `task accept`                      | The spec agent starts within about 15 seconds.                                                                                      |
| (wait)                             | The spec agent writes a spec, or stops with a question.                                                                             |
| `task approve` (or `task changes`) | Approval sends it to build; changes send it back to the spec agent.                                                                 |
| (wait)                             | The builder pushes `officina/task-<n>`, Officina opens the pull request, two reviewers check it, the chooser writes a checklist.    |
| `task approve` (or `task changes`) | Your verification of the result. Low-risk changes in a project that allows it skip this step (below).                               |
| Approve and merge on GitHub        | As with any pull request. The task closes itself.                                                                                   |

At any point, `task show` says where the task is and what it waits for, and ends with the exact next
command.

## Step by step

1. **See what exists.**

   ```bash
   scripts/officina task list
   ```

2. **Open a request.** Describe the outcome in plain words; say what must not change.

   ```bash
   scripts/officina task create --title "Short imperative title" --request "What you want, why, and what must stay as it is."
   ```

   The interviewer reads it and the code it is about, then asks up to four questions, one at a
   time, in the task thread. Answer each with `task answer --number 1 --text "..."`. When the
   request is clear it writes a summary with "done when" checks, renames the task in your words,
   and sends it to triage. `task submit --number 1` sends it to triage as it is at any point; add
   `--skip-interview` to `task create` to skip the interview entirely.

3. **Accept it**, so the spec agent picks it up.

   ```bash
   scripts/officina task accept --number 1
   ```

4. **Read the spec or answer the question.** Run `task show` until the stage is `spec_review`, or it says `BLOCKED`.

   ```bash
   scripts/officina task show --number 1
   scripts/officina task answer --number 1 --text "Your answer"
   ```

5. **Decide on the spec.**

   ```bash
   scripts/officina task approve --number 1
   scripts/officina task changes --number 1 --note "What to change in the spec"
   ```

6. **Wait for build and review.** `task show` lists every agent run with its cost and a link to its
   live session in the Claude Console. The pull request link appears once the builder has pushed.

7. **Verify the result** on the pull request, using the chooser's checklist, then decide.

   ```bash
   scripts/officina task approve --number 1
   scripts/officina task changes --number 1 --note "What is wrong"
   ```

8. **Merge on GitHub.** Approve and merge the pull request as usual; the webhook closes the task.

To stop a task at any time: `scripts/officina task cancel --number 1 --reason "Why"`.

## Reviews on GitHub and low-risk changes

- **Copilot and people on GitHub.** When Copilot leaves inline comments on the pull request, or a person
  requests changes there, the task goes back to the builder with those comments, and comes back
  through review. Officina resolves those threads once the fix is verified.
- **Low-risk changes.** In a green lane with `auto_verify: true`, a result that the chooser only asks
  to glance at skips the verification step, unless merging deploys to production
  (`release.on_merge: production`, the default). The spec is always approved by a person, and a
  person always merges.
- **Nothing merges by itself.** Officina approves the pull request as the verifier when they have
  GitHub connected, then shows it as waiting for a person to merge. It never merges and never turns
  on auto-merge.

## When something goes wrong

- **An agent run failed or ran out of budget:** the task shows `BLOCKED` with the reason. Answer it
  to let the step run again, or cancel the task.
- **`the task changed meanwhile`:** someone or something acted first. Run `task show` and retry.
- **A red-lane task stops after the spec:** that is by design. Agents never build in the red lane; a
  person implements the approved spec.
