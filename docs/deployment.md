# Deployment

Infrastructure for the Vici instance of Officina. Identifiers here are not secrets; secret values never go in this repository.

## Resources

| Resource            | Identifier                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fly.io app          | `vici-officina` (org `vici`)                                                                   | `https://vici-officina.fly.dev`; no machines until the first deploy. The name `officina` is taken on Fly.                                                                                                                                                                                                                                                      |
| Postgres            | not created yet                                                                                | Provisioned at the first deploy, so it does not bill while nothing runs.                                                                                                                                                                                                                                                                                       |
| GitHub App          | **Officina Workshop**, slug `officina-workshop`, App ID `4965437`, owned by `@AntonioVentilii` | The name "Officina" is reserved on GitHub. Installable on any account. Webhook inactive until deployed. Permissions: contents, issues, pull requests read/write; checks and metadata read-only; no Actions, Workflows or Administration. Callback `https://vici-officina.fly.dev/auth/github/callback` (strict matching). Not installed on any repository yet. |
| Anthropic workspace | **Officina**, `wrkspc_01GSzPabbQGWhbSVM7LQE7oV`, geo US                                        | Managed Agents available. No API key and no spend limit yet.                                                                                                                                                                                                                                                                                                   |

## Secrets

Stage them without deploying: `fly secrets set --app vici-officina --stage NAME=value`.

| Secret                   | Status | Where it comes from                                                                                                               |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`          | staged | `4965437`                                                                                                                         |
| `GITHUB_APP_PRIVATE_KEY` | staged | Generated on the GitHub App settings page and piped from the downloaded file without being read; the file was moved to the Trash. |
| `GITHUB_WEBHOOK_SECRET`  | to do  | Generate with `openssl rand -hex 32`, stage it, and set the same value on the GitHub App webhook.                                 |
| `ANTHROPIC_API_KEY`      | to do  | Claude Console, workspace Officina, API keys.                                                                                     |
| `DATABASE_URL`           | to do  | Set when Postgres is attached.                                                                                                    |

Without `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `ANTHROPIC_API_KEY` the API still runs and logs `engine disabled` with the missing names.

## Runtime

The API is built from the root `Dockerfile` (which includes `agents/`) and configured by `fly.toml` (region `ams`, health check on `/health`, one machine always on because the scheduler runs inside it). On boot it validates its environment, applies pending migrations, fails runs orphaned by a previous process and interrupts their sessions, then starts the scheduler every `SCHEDULER_INTERVAL_MS` (default 15 seconds). Run exactly one machine: orphaned-run recovery assumes a single scheduler.

## First deploy

1. Create and attach Postgres to `vici-officina`.
2. Stage `GITHUB_WEBHOOK_SECRET` and `ANTHROPIC_API_KEY`, then `fly deploy`; confirm `https://vici-officina.fly.dev/health` and a log line `api listening` with `engine: true`.
3. Sync the agents: `fly ssh console --app vici-officina -C "bun apps/api/src/cli.ts setup-agents"`.
4. Install the GitHub App on `ViciApp/vici-app` only (selected repositories).
5. Register the project: `fly ssh console --app vici-officina -C "bun apps/api/src/cli.ts add-project --workspace vici --repo ViciApp/vici-app --owner-email <email> --owner-name Antonio"`. Until `.github/officina.yml` is merged in vici-app, pass it with `--config-file`.
6. Activate the GitHub App webhook with the same `GITHUB_WEBHOOK_SECRET`.
7. Set a monthly spend limit on the Officina Anthropic workspace.
