# Deployment

Infrastructure for the Vici instance of Officina. Identifiers here are not secrets; secret values never go in this repository.

## Resources

| Resource            | Identifier                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fly.io app          | `vici-officina` (org `vici`)                                                                   | `https://vici-officina.fly.dev`; no machines until the first deploy. The name `officina` is taken on Fly.                                                                                                                                                                                                                                                      |
| Postgres            | not created yet                                                                                | Provisioned at the first deploy, so it does not bill while nothing runs.                                                                                                                                                                                                                                                                                       |
| GitHub App          | **Officina Workshop**, slug `officina-workshop`, App ID `4965437`, owned by `@AntonioVentilii` | The name "Officina" is reserved on GitHub. Installable on any account. Webhook inactive until deployed. Permissions: contents, issues, pull requests read/write; checks and metadata read-only; no Actions, Workflows or Administration. Callback `https://vici-officina.fly.dev/auth/github/callback` (strict matching). Not installed on any repository yet. |
| Anthropic workspace | **Officina**, `wrkspc_01GSzPabbQGWhbSVM7LQE7oV`, geo US                                        | Managed Agents available. No API key and no spend limit yet.                                                                                                                                                                                                                                                                                                   |

## Secrets to set (by a human, never by an agent)

Stage them without deploying: `fly secrets set --app vici-officina --stage NAME=value`.

| Secret                     | Where it comes from                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_PRIVATE_KEY`   | GitHub App settings -> Private keys -> Generate. Set from the downloaded file: `fly secrets set --app vici-officina --stage GITHUB_APP_PRIVATE_KEY="$(cat <path-to>.private-key.pem)"`, then delete the file. |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App settings -> Client secrets -> Generate.                                                                                                                                                            |
| `GITHUB_WEBHOOK_SECRET`    | Generate locally (`openssl rand -hex 32`); paste the same value in the GitHub App webhook settings when activating the webhook.                                                                               |
| `ANTHROPIC_API_KEY`        | Claude Console, workspace Officina -> API keys -> Create key.                                                                                                                                                 |
| `DATABASE_URL`             | Set automatically when Postgres is attached at the first deploy.                                                                                                                                              |

## Runtime

The API is built from the root `Dockerfile` and configured by `fly.toml` (region `ams`, health check on `/health`). On boot it validates its environment and applies pending migrations. Required environment: `DATABASE_URL`, `GITHUB_WEBHOOK_SECRET` (at least 32 characters); `PORT` defaults to 8080.

## At first deploy

1. Create and attach Postgres to `vici-officina`.
2. Generate and stage `GITHUB_WEBHOOK_SECRET`, then `fly deploy`; confirm `https://vici-officina.fly.dev/health`.
3. Activate the GitHub App webhook with `GITHUB_WEBHOOK_SECRET`.
4. Set a monthly spend limit on the Officina Anthropic workspace.
5. Install the GitHub App on `ViciApp/vici-app` only (selected repositories).
