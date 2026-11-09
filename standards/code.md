# The code standard

The rules every agent and every person follows when changing code in a repository Officina serves, or any repository that links this page. They apply whatever the stack.

This page is the only copy. A repository links it from its `AGENTS.md` and never restates these rules; its own `docs/ai/**` pages add only what is specific to it (its structure, its patterns, its catalog of shared code, its commands). When this page changes, every repository that links it follows at once.

Cite a rule by its number and name, for example "rule 5, one value, one place", so the author can find it. Numbers never change: a new rule is added at the end.

## Rules

### 1. Idiomatic

Follow the conventions of the surrounding code: its naming, its file layout, its error handling, its test style. Not the conventions of your training data, and not those of another repository. When the code holds two styles, follow the one its `docs/ai/patterns.md` names, or the more recent one.

### 2. Atomic

One logical change per pull request. No drive-by refactors, no "while I'm here" edits, no formatting churn in lines the change does not touch. Something worth fixing that is outside the change becomes a follow-up, named in the pull request body.

### 3. Small

Five small pull requests beat one big one. When a change needs a preparatory refactor, land the refactor first, on its own.

### 4. Reuse before you write

Before adding a component, a util, a constant, a service or a type, search the repository's catalog (`docs/ai/reusability.md`) and the code for one that already does the job. Extend what exists instead of writing a second one. When something new really is needed and others could use it, add it to the catalog in the same pull request.

### 5. One value, one place

A list, a label, a translation, a mapping, a threshold, a name in several languages or a rule is written once, in the module that owns it. Everything else imports it or derives from it: the UI, a prompt, a regular expression, a doc table, a locale file. Before writing a value, look for where it already lives and extend that. When you find the same value in two places, make it one in the same change. Only a test may spell out the value it expects.

### 6. Typed and explicit

No `any`, no `as unknown as`, no ignored or suppressed type checker warnings. Errors are explicit types or values the caller has to handle, never swallowed. In Rust, no `unwrap()` or `expect()` outside tests.

### 7. Respect the structure

New code goes in the module that owns that concern, and dependencies point the way the repository's `docs/ai/structure.md` says. No new top-level folder, package or layer without asking the owner first.

### 8. Design for change

Small functions with one responsibility. Pure logic kept apart from I/O, so it can be tested without a network or a database. Seams where the repository already has them (ports, adapters, stores), not new ones. The patterns in the repository's `docs/ai/patterns.md`, not new ones.

### 9. No smells

No dead or commented-out code. No magic values outside their owner (rule 5). No god files or god functions. No boolean flag parameters that switch a function's behaviour: write two functions. No deep nesting: return early. No copy-paste with small edits: extract what the copies share.

### 10. Tests prove behaviour

Test what the change does, at the layer the repository's `docs/ai/testing.md` names, through the public surface rather than private details. Never skip, weaken or delete a test to get to green; a test that is wrong is fixed in its own change, with the reason.

### 11. Respect CI

Run the repository's local gates before opening a pull request (its `docs/ai/pr-and-ci.md` lists them). Never silence a linter, a type check or a test, and never work around a branch rule.

### 12. Do not overengineer

The smallest correct change wins. No abstraction without duplication that already exists. No speculative options, settings or extension points. No new dependency without the owner's approval and a stated reason.

### 13. Docs adapt with the code

The meta-update rule: a pull request that adds a pattern, a shared piece of code, a naming convention, a policy or a workflow updates the matching `docs/ai/**` page in the same pull request. The repository's `docs/ai/governance.md` says which page covers which kind of change. A repository that does not hold these pages yet gets them first, in their own docs-only pull request, before other changes rely on them. Docs that no longer match the code are a bug.

### 14. Writing

No em dashes or en dashes anywhere, in code, comments, docs or messages: use hyphens, commas, colons or two sentences. Comments say why, never what. No AI attribution in commits, pull requests or code.

### 15. Idempotent

Anything that can run twice leaves the same result as running once: migrations, jobs and scheduled runs, webhooks and retried handlers, scripts, seeds, setup commands, and every write driven by an outside event. Claim the work before doing it, so a second run finds it taken. Write with upserts or natural keys, never a blind insert. Check before acting, so a step already done is skipped. Give every retry a key, so the receiver can tell a repeat from new work. A test runs the thing twice and asserts that nothing changed the second time.

## Truth hierarchy

When two sources disagree, the higher one wins:

1. The code, as it is on the default branch.
2. CI: the checks that must pass.
3. `CODEOWNERS`: who reviews what.
4. The repository's `docs/ai/**` pages.
5. Its `AGENTS.md`, and this page.
6. Tool layers: `CLAUDE.md`, `.cursor/rules`, Copilot instructions and the like. They point to `AGENTS.md` and never contradict it.

A contradiction is a bug in the lower source. Do not pick a side silently: stop and ask the owner, or fix the lower source in its own change.
