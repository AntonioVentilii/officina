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

To see who accepted and who is active, list the project's members: their role, when they first signed in, when their latest link was sent and whether it was used, is still pending or expired, when they last opened the board and whether they added Officina to Claude. Pass `--repo <owner/name>` when there are several projects.

```bash
scripts/officina members --repo ViciApp/vici-app
```

On the board, owners and maintainers have the same list under **Members**, and an owner can make a fresh invite link there for someone who has not signed in yet. When someone signs in for the first time, the project's owners get a line in their **Inbox**.

## From Claude

Add Officina to Claude once and do everything below from a chat, in plain words.

1. In claude.ai open **Customize > Connectors**, choose **Add > Add custom connector**, name it Officina and paste `<public URL>/mcp`. Press **Continue** and **Add**, keeping the sign-in it detects (OAuth, registered automatically), then **Connect**. The desktop app picks it up from the same account. In Claude Code: `claude mcp add --transport http officina <public URL>/mcp`, then `/mcp` to sign in.
2. Claude opens the board's **Connect an app** page. Sign in if asked, check the name, and press **Allow**. The welcome guide waits until after this page.
3. Ask things like "what is waiting on me in Officina?", "open a request: the Sign up button should say Join", or "show task 12 and help me check it". Claude asks what it needs, then calls Officina as you, with your role.

To stop it, remove the connector in Claude.

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

Two moments wait on a person instead of an agent. When an agent finds that the task needs something
agents cannot do or decide (a domain, a secret, a new host, an account, access, publishing somewhere
new), the task is handed to the owner or a maintainer with the list of what is needed; `task answer`
resumes it. When the plan says a person must build it (or the lane forbids agents), it waits in
`ready` until a maintainer, or a contributor with the `developer` domain, runs
`task claim --number <n>`. They build it on `officina/task-<n>` by hand or with their own agents,
push, and hand it in from the board ("Hand in the build") or from Claude (`hand_in_build`); it then
goes to the same review as an agent's build.

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
  through review. Officina resolves those threads once the fix is verified. A Copilot review with no
  comment on the code but a verdict (green, blue or yellow) goes back to the builder too, once: it checks
  each point, changes what is right or finishes without a push, and answers on the pull request
  (always for a blue one).
- **Asking Copilot for the review.** A pull request Officina opens is opened by the GitHub App,
  which has no Copilot seat, so a branch rule asking for Copilot's review does not start it. A
  project that sets `pull_request.copilot_review: true` in `.github/officina.yml` has Officina ask
  Copilot itself, as the person who requested the task, on the scheduler's next pass after the
  pull request is open (tasks already in flight get it too once the setting is on). That
  person needs GitHub connected in Officina and a Copilot seat (or the organization's permission to
  use Copilot review without one). When the request fails the task goes on and its timeline says
  why; ask for the review on GitHub by hand.
- **Other review bots.** A bot that comments on the code (CodeRabbit's inline comments, for example)
  sends the task back like Copilot. A bot that only writes a summary, as a review or as a comment on
  the pull request, counts once the project lists it in `pull_request.review_bots`. A comment
  reaches the builder a few minutes after the bot last edited it, so a "working on it" placeholder
  is never what the builder reads.
- **Failing checks.** A check suite or a commit status that fails on the pull request's head sends
  the task back to the builder with what failed, at any point from review to merge.
- **Commits from outside Officina.** When a bot, a person or GitHub's "Update branch" pushes to the
  task branch after the builder, Officina takes the new head in within a scheduler pass: the lane
  and guardrails are checked again and the task goes back to review, then to your verification.
- **Low-risk changes.** In a green lane with `auto_verify: true`, a result that the chooser only asks
  to glance at skips the verification step, unless merging deploys to production
  (`release.on_merge: production`, the default). The spec is always approved by a person.
- **Who merges.** By default a person: Officina approves the pull request as the verifier when they
  have GitHub connected, then shows it as waiting for a person to merge. A project that sets
  `pull_request.auto_merge: true` lets the chooser decide, result by result, that GitHub may merge
  it once its checks pass; the task's plan says which it chose.

## When something goes wrong

- **An agent run failed or ran out of budget:** the task shows `BLOCKED` with the reason. Answer it
  to let the step run again, or cancel the task.
- **`the task changed meanwhile`:** someone or something acted first. Run `task show` and retry.
- **A red-lane task stops after the spec:** that is by design. Agents never build in the red lane; a
  person implements the approved spec.
