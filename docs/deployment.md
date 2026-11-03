# Deployment

Infrastructure for the Vici instance of Officina. Identifiers here are not secrets; secret values never go in this repository.

## Resources

| Resource            | Identifier                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fly.io app          | `vici-officina` (org `vici`), deployed                                                         | `https://vici-officina.fly.dev`, live. Exactly one machine (`fly scale count 1`): the scheduler runs inside it, and Fly's default high-availability pair would mean two schedulers. IPv4 (shared) and IPv6 allocated by hand after the first deploy failed to. The name `officina` is taken on Fly.                                                                                                                                                                                                        |
| Postgres            | `officina-pg` (org `vici`, ams, shared-cpu-1x, 1 GB)                                           | Unmanaged Fly Postgres, attached to the app as `DATABASE_URL`. Managed Postgres was tried first and destroyed: its cheapest plan is $38 a month.                                                                                                                                                                                                                                                                                                                                                           |
| GitHub App          | **Officina Workshop**, slug `officina-workshop`, App ID `4965437`, owned by `@AntonioVentilii` | The name "Officina" is reserved on GitHub. Installable on any account. Webhook inactive until deployed. Permissions: contents, issues, pull requests read/write; checks and metadata read-only; no Actions, Workflows or Administration. Callback `https://vici-officina.fly.dev/auth/github/callback` (strict matching). Installed on `ViciApp/vici-app` only (installation `165108978`). Webhook active. Subscribed events: check_suite, issue_comment, issues, pull_request, pull_request_review, push. |
| Anthropic workspace | **Officina**, `wrkspc_01GSzPabbQGWhbSVM7LQE7oV`, geo US                                        | Agents synced; per-project environment `env_01BLpDE9hPGeGhGTRfntdrQX`. No API key anywhere (federation). Spend limit still to set.                                                                                                                                                                                                                                                                                                                                                                         |

## Secrets

Stage them without deploying: `fly secrets set --app vici-officina --stage NAME=value`.

| Secret                     | Status     | Where it comes from                                                                                                                                                                                                                                   |
| -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`            | set        | `4965437`                                                                                                                                                                                                                                             |
| `GITHUB_APP_PRIVATE_KEY`   | set        | Generated on the GitHub App settings page and piped from the downloaded file without being read; the file was moved to the Trash.                                                                                                                     |
| `GITHUB_APP_CLIENT_SECRET` | set        | Generated on the GitHub App settings page and copied into Fly from the clipboard without being read. With `OFFICINA_TOKEN_KEY` it turns on GitHub sign-in and approving and merging as the verifier. The client ID is public and lives in `fly.toml`. |
| `OFFICINA_TOKEN_KEY`       | set        | `openssl rand -base64 32`, piped straight into Fly. Encrypts members' GitHub tokens at rest; rotating it only means members connect GitHub again.                                                                                                     |
| `GITHUB_WEBHOOK_SECRET`    | set        | Generate with `openssl rand -hex 32`, stage it, and set the same value on the GitHub App webhook.                                                                                                                                                     |
| `ANTHROPIC_API_KEY`        | not needed | Production authenticates by workload identity federation (below). An API key is only for local development on a non-Fly host.                                                                                                                         |
| `ANTHROPIC_MODEL`          | not needed | Unset, the agents run the newest Opus the Models API lists. Set it only to hold the agents on a specific model id.                                                                                                                                    |
| `DATABASE_URL`             | set        | Set by `fly postgres attach`.                                                                                                                                                                                                                         |

Without the GitHub App credentials or any Anthropic credentials the API still runs and logs `engine disabled` with the missing names.

## Anthropic credentials: workload identity federation

No Anthropic API key exists in production. The machine mints a short-lived OIDC token from Fly's agent socket (issuer `https://oidc.fly.io/vici`, subject `vici:vici-officina:<machine>`, audience `https://api.anthropic.com`), and the federation rule exchanges it for a short-lived access token scoped to the Officina workspace. Each identity token is single-use, so a fresh one is minted per exchange.

These identifiers are public and live in `fly.toml` under `[env]`:

| Setting                        | Value                                                                    |
| ------------------------------ | ------------------------------------------------------------------------ |
| `ANTHROPIC_FEDERATION_RULE_ID` | `fdrl_018jgpUk8osKSBgzbZnAna6D` (rule `officina-fly`, issuer `fly-vici`) |
| `ANTHROPIC_ORGANIZATION_ID`    | `b4c6858e-c21f-469d-b0e7-d615481fbc2c`                                   |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | `svac_0186Y6oZ4rytk8sDqDJiT2sV` (service account `officina-engine`)      |
| `ANTHROPIC_WORKSPACE_ID`       | `wrkspc_01GSzPabbQGWhbSVM7LQE7oV` (workspace Officina)                   |

The rule only accepts tokens whose subject starts with `vici:vici-officina:` and whose `app_name` claim is `vici-officina`, so only that Fly app can assume this identity. The boot log line `anthropic credentials` reports which mode is in use.

## Runtime

The API is built from the root `Dockerfile` (which includes `agents/`) and configured by `fly.toml` (region `ams`, health check on `/health`, one machine always on because the scheduler runs inside it). On boot it validates its environment, applies pending migrations and starts listening; then the engine fails runs orphaned by a previous process and interrupts their sessions, resolves the Opus model (log line `model in use`) and syncs the role agents to it (`agents synced`), then starts the scheduler every `SCHEDULER_INTERVAL_MS` (default 15 seconds). Run exactly one machine: orphaned-run recovery assumes a single scheduler.

## Project: vici-app

Registered as project `010b5462-fb9f-4c75-8b71-39643a8b1e7a` in workspace `vici`, owned by the instance owner. Its config came from the adoption spec while `.github/officina.yml` is not yet merged in vici-app; once it is, a push to `main` refreshes it automatically.

## First deploy (done 2026-09-26)

Kept as the runbook for a second instance.

1. Create and attach Postgres to `vici-officina`.
2. Stage `GITHUB_WEBHOOK_SECRET`, then `fly deploy`; confirm `https://vici-officina.fly.dev/health`, a log line `api listening` with `engine: true`, and `anthropic credentials` with `mode: federation`.
3. Sync the agents: `fly ssh console --app vici-officina -C "bun apps/api/src/cli.ts setup-agents"`. Since agents sync on every boot this is now only a manual override.
4. Install the GitHub App on `ViciApp/vici-app` only (selected repositories).
5. Register the project: `fly ssh console --app vici-officina -C "bun apps/api/src/cli.ts add-project --workspace vici --repo ViciApp/vici-app --owner-email <email> --owner-name Antonio"`. Until `.github/officina.yml` is merged in vici-app, pass it with `--config-file`.
6. Activate the GitHub App webhook with the same `GITHUB_WEBHOOK_SECRET`.
7. Set a monthly spend limit on the Officina Anthropic workspace.
8. Check the federation rule's authentication log in the Console for a successful exchange.

## Still open

- Set a monthly spend limit on the Officina Anthropic workspace.
- Merge `.github/officina.yml` and `docs/ai/officina.md` in vici-app, then drop the machine-local config copy.
- No webhook delivery has been received yet; the first event on vici-app will confirm the signature path.
