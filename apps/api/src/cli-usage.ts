import { ROLES, branchForTask } from '@officina/core';
import { INVITE_TTL_DAYS, SIGN_IN_TTL_MINUTES } from './people';
import { BY_RULE, MODEL_CHOICES } from './tasks';

/** What the CLI takes, printed with `--help` and with every mistake in its arguments. */
export const USAGE = `usage (on your machine, prefix with scripts/officina; on the server, with bun apps/api/src/cli.ts):

  Tasks
    task list
    task show     --number <n>
    task create   --title "<title>" --request "<what you want, in plain words>"
                  [--skip-interview | --interview]
                                               left out, a maintainer's or owner's request skips
                                               the interview and anyone else's has it
    task submit   --number <n>                 send a request to triage without more questions
    task accept   --number <n>
    task claim    --number <n>                 build it yourself instead of the agent
    task hand-in  --number <n> --title "<pull request title>" [--checked "<what you checked>" ...]
                  [--body "<pull request body>"]
                                               after pushing ${branchForTask('<n>')}: send your build to review;
                                               --body only when the project names a pull request
                                               template, and then required, in its sections
    task hand-back --number <n>                give back a build you claimed, so it waits to be built
                                               again; with steer, also another person's build
    task approve  --number <n>
    task changes  --number <n> --note "<what to change>"
    task answer   --number <n> --text "<answer to the open question>"
                  [--option <letter> --version <v>]
                                               or pick an option the question offers, by the letter
                                               and version task show gives, with --text as a note
    task decline  --number <n> --reason "<why>"
    task cancel   --number <n> --reason "<why>"
    task force-model --number <n> --tier ${MODEL_CHOICES.join('|')}
                                               with steer: every agent step on the task runs on that
                                               tier instead of the one the rule picks; ${BY_RULE} gives it back
    task link     --number <n> [--parent <p>] [--after <m> ...]   sets the task's parent and the tasks it waits for, replacing earlier links; with neither, it removes them

    Every task command also takes --repo <owner/name> (optional with a single project)
    and --as <email> (defaults to the project owner).

  People
    login-link    [--email <email>]          one-time sign-in link to the board, valid ${SIGN_IN_TTL_MINUTES} minutes
    invite        --email <email> --name "<name>" --role ${ROLES.join('|')}
                  [--domains product,legal]  adds or updates a member; the link is valid ${INVITE_TTL_DAYS} days
    members                                  who is in the project, when they joined, whether their
                                             latest link was used, when they were last seen and
                                             whether they connected Claude
    access-log                               who signed in or out, who sent sign-in links, which
                                             GitHub accounts and Claude apps each member connected

    People commands also take --repo <owner/name> (optional with a single project).

  Trials (compare two ways of running the builder on a past task; see docs/ai/workflows/trial.md)
    trial-build   --number <n> --base <full sha> --arm reader|solo --budget-usd <cap> [--attempt <a>]
                  [--run]                    without --run, prints the plan and brief and spends
                                             nothing; with it, runs the build on its own trial
                                             agents and branch and prints what it cost and read
    trial-measure --session <session id>     the same measure for any finished session

  Setup
    setup-agents
    add-project --workspace <name> --repo <owner/name> --owner-email <email> --owner-name <name> [--config-file <path>]`;
