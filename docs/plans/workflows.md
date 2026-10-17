# Workflows (built-in CI/CD)

Run GitHub Actions–syntax workflows inside Dokploy, triggered by git events, on dedicated workflow servers.

## Decisions

- **Self-hosted only.** Hidden and rejected when `IS_CLOUD` is set (sidebar `isEnabled`, router guards, webhook handler).
- **Workflow sources:** `.github/workflows/*.yml` and `.dokploy/workflows/*.yml`, same syntax, same parser.
- **`.github/workflows` is opt-in per repo** (`runGithubWorkflows`, default `false`) so repos that still use GitHub Actions don't run every workflow twice. `.dokploy/workflows` is on by default.
- **Execution v1:** [`nektos/act`](https://github.com/nektos/act) invoked over SSH on a workflow server, one server per run. **v2:** implement the server side of Gitea's runner protocol (`actions-proto-def`) so stock `act_runner` can pick up individual jobs.
- **No custom Actions executor.** Dokploy parses only what it needs server-side (triggers, filters, jobs, `needs`, `runs-on`); act handles expressions, matrix, services, actions, outputs.
- **Provider scope v1:** GitHub only. GitLab / Gitea / Bitbucket via per-provider adapters later.

## Current state (touch points)

| Area | Location | Change |
|---|---|---|
| Server type enum `["deploy","build"]` | `packages/server/src/db/schema/server.ts:29` | Replace with roles array |
| Server type checks | `apps/dokploy/server/api/routers/server.ts` (~144, 249–277), `components/dashboard/settings/servers/{handle,show,setup,validate}-server(s).tsx`, `components/dashboard/onboarding/steps/server-step.tsx`, `components/dashboard/deployments/show-deployments-table.tsx`, `settings/users/add-permissions.tsx` | Use role helpers |
| GitHub webhook | `apps/dokploy/pages/api/deploy/github.ts` (only `push`/`pull_request`) | Add event router + workflow path |
| GitHub App manifest | `components/dashboard/settings/git/github/add-github-provider.tsx:46-52` | Add `release` event, `checks: write`, `statuses: write` |
| Notifications | `packages/server/src/db/schema/notification.ts`, `packages/server/src/utils/notifications/build-error.ts` | Add workflow run events |
| Queues | `apps/dokploy/server/queues/*` (BullMQ) | New workflows queue |
| Cron | `apps/schedules` | Register `schedule:` triggers |
| Sidebar | `apps/dokploy/components/layouts/side.tsx` | New "Workflows" item |

## Phase 0: Server roles (done)

- `serverRoles serverRole[]` (`deploy | build | workflow`), not null, default `{deploy}`.
- Migration: `drizzle-fork/0000_server_roles` adds the column and backfills it from `serverType`. `serverType` stays (upstream owns it) and is derived from roles on every write (`legacyServerType`). See [fork migrations](../fork-migrations.md).
- API: `server.create` / `server.update` take `serverRoles`; `serverType` is still accepted as a deprecated alias (`resolveServerRoles`). Adding the `workflow` role is rejected on cloud.
- Server pickers: `server.withSSHKey` (deploy), `server.buildServers` (build), `server.workflowServers` (workflow, empty on cloud). A multi-role server appears in each matching list.
- Setup: servers with the `deploy` role get the full Swarm/Traefik setup; any other combination gets the build setup (Docker, nixpacks, buildpacks, railpack). Installing `act` for the `workflow` role is deferred to Phase 2, where it's first used.
- UI: role checkboxes in the server form (workflow hidden on cloud, warning for deploy+workflow), one badge per role on server cards.

## Phase 1: Repositories, parsing, read-only UI (done)

Shipped as: migration `drizzle-fork/0001_workflow_repositories`, parser `packages/server/src/utils/workflows/parser.ts`, service `packages/server/src/services/workflow.ts`, router `workflow.*`, pages `/dashboard/workflows` (Runs / Repositories tabs, Import dialog) and `/dashboard/workflows/repositories/[workflowRepositoryId]`. `.github` workflows are always synced and listed, but only run when `runGithubWorkflows` is on.


Schema (`packages/server/src/db/schema/workflow.ts`):

- `workflowRepository`: `workflowRepositoryId`, `organizationId`, `githubId` (+ nullable `gitlabId`/`giteaId`/`bitbucketId` for later), `owner`, `repository`, `defaultBranch`, `runGithubWorkflows` (default false), `runDokployWorkflows` (default true), `defaultServerId` → server, `createdAt`. Unique on (organization, provider, owner, repository).
- `workflowDefinition`: `workflowRepositoryId`, `path`, `source` (`github` | `dokploy`), `name`, `triggers` (jsonb, normalized), `jobs` (jsonb: id, name, needs, runs-on), `sha`, `parseError`, `updatedAt`. Unique on (repo, path).

Parsing:

- Fetch files via the GitHub contents API on import, on push to the default branch, and on manual refresh.
- Normalize `on:` (string / array / map forms) into `{ event, types?, branches?, branchesIgnore?, tags?, tagsIgnore?, paths?, pathsIgnore?, cron?, inputs? }[]`.
- Store parse errors and show them in the UI; don't block other files.

UI:

- Sidebar "Workflows" → `/dashboard/workflows`, gated by `!isCloud && permissions.workflow.read`.
- New permission resource `workflow` (`read`, `create`, `run`, `delete`).
- Tabs: **Runs** (empty until Phase 2), **Repositories** (list, toggles, default server, workflow files with parse status, refresh), **Import** (git provider → repo picker, reusing the application GitHub provider pickers).

## Phase 2: Events and execution (done)

Shipped as: migration `drizzle-fork/0002_workflow_runs`; `utils/workflows/{events,triggers,act,act-log,ssh,executor,queue}.ts`; `services/workflow-run.ts`; router `workflow.{runs,oneRun,dispatch,rerun,cancelRun,branches}`; pages `/dashboard/workflows/runs/[workflowRunId]` plus the Run dialog and runs list. Notes on what differs from the original sketch:

- One run at a time per workflow server (in-memory FIFO, like deployments). Server choice: the repository's server, else the least busy workflow server. `runs-on` labels map to runner images, not to servers.
- Pull requests run against the head commit, not GitHub's merge commit.
- Fork pull requests are skipped (recorded as a skipped run) unless the author has write access; trusted runs get `GITHUB_TOKEN`, untrusted ones get no secrets and no Docker socket.
- Re-run repeats the whole run as a new attempt; re-running only failed jobs isn't supported because act can't reuse earlier job outputs.
- Secrets and step/job names are masked before they reach log files or the database.
- Existing GitHub Apps must be updated by hand to subscribe to `release` and `create` events (new apps get them from the manifest).


Event routing (split `github.ts` into `github/index.ts` dispatcher, `github/deploy.ts` existing logic, `github/workflows.ts`):

| Workflow trigger | GitHub delivery |
|---|---|
| `push` (incl. merges into a branch) | `push` |
| `pull_request` (`opened`, `synchronize`, `reopened`, `closed`; merged = `closed` + `merged: true`) | `pull_request` |
| `release` (`published`, `created`, `released`, …) | `release` |
| tags | `push` on `refs/tags/*`, `create` |
| `workflow_dispatch` | Dokploy UI (inputs form from `inputs:`) |
| `schedule` | `apps/schedules` cron |

- Look up `workflowRepository` by provider + owner/repo, filter enabled sources, match each definition's triggers (branch/tag globs, `paths` via the push/PR changed files, `types`), create runs.
- Existing application deploy handling keeps running unchanged alongside.

Schema additions:

- `workflowRun`: `workflowRunId`, `workflowRepositoryId`, `workflowDefinitionId`, `runNumber` (per definition), `event`, `payload` (jsonb), `ref`, `sha`, `actor`, `status` (`queued | in_progress | success | failure | cancelled`), `serverId`, `logPath`, `createdAt`, `startedAt`, `finishedAt`.
- `workflowJob`: `workflowRunId`, `jobKey`, `name`, `matrix` (jsonb), `status`, `startedAt`, `finishedAt`.
- `workflowStep`: `workflowJobId`, `number`, `name`, `status`, `startedAt`, `finishedAt`.

Execution (BullMQ `workflows` queue, concurrency per server):

1. Pick server: `runs-on` label match against workflow servers, else repo `defaultServerId`, else fail with a clear error.
2. Over SSH: shallow clone at `sha` into `/etc/dokploy/workflows/<runId>`, write `event.json`, write secrets file (0600).
3. `act <event> -W <path> --eventpath event.json --secret-file … --var-file … --json` (plus `-P` platform image mappings).
4. Parse act's JSON log stream into job/step status updates; tee raw logs to `logPath`; stream to the UI via the existing deployment-log WSS channel.
5. Clean up workdir and secrets file in `finally`.
6. Cancel = kill the act process group + `docker rm -f` containers labelled for the run.

Security:

- Fork PRs get no secrets (mirror GitHub). Reuse the PR-author trust checks already in `github.ts`.
- Workflows never run on the Dokploy host; a server with the `workflow` role is required.

UI: Runs tab (filters: status, repo, branch, event), run detail page `/dashboard/workflows/runs/[runId]` with `needs` graph, step logs, re-run all / re-run failed, cancel, and "Run workflow" dispatch dialog.

## Phase 3: Notifications and GitHub status (done)

Shipped as: migration `drizzle-fork/0003_workflow_notifications`, `utils/workflows/{notifications,check-runs}.ts`, router `workflow.{notificationRules,notificationChannels,createNotificationRule,removeNotificationRule}`, and a Notifications tab on the Workflows page. Instead of adding columns to upstream's `notification` table (which would touch every notification type's schema, service and form), rules live in `workflow_notification` and point at existing channels, with optional repository and branch filters. The Custom (webhook) channel receives a JSON payload (`type: "workflow"`, `status`, `repository`, `workflow`, `runNumber`, `branch`, `sha`, `runUrl`, ...). Check runs are named `Dokploy / <workflow>`; without the Checks permission Dokploy logs one warning per repository and carries on.


- `notifications`: add `workflowRunFailed`, `workflowRunSucceeded` booleans; `sendWorkflowRunNotifications` following `build-error.ts`. The existing `custom` type covers arbitrary failure webhooks; all other channels work automatically.
- Optional repo/branch filter on the notification.
- GitHub Checks API: create a check run per workflow run (or job), update on completion, link back to the Dokploy run page. Existing GitHub Apps must accept the new permissions; show a banner when the installation lacks them.

## Phase 4: Secrets, variables, scheduling, concurrency (done)

Shipped as: migration `drizzle-fork/0004_workflow_env_concurrency`, `utils/workflows/expressions.ts`, router `workflow.{env,setEnv,removeEnv}`, a Secrets & Variables tab (organization-wide) and card (per repository).

- Secrets and variables live in `workflow_env` (values encrypted with Dokploy's `encryptedText`). Repository values override organization values by name. Secret values are never returned by the API and are masked in logs; untrusted runs get neither.
- `schedule:` triggers use node-schedule in the Dokploy process (UTC, like GitHub), reconciled at startup and whenever repositories, workflows or settings change. Each tick re-reads the workflow from the default branch's latest commit and only runs if that cron is still there.
- `concurrency:` (workflow level) follows GitHub: a new run replaces a pending run in the same group; with `cancel-in-progress` it also cancels the running one. Groups are scoped to the repository. Group expressions support context lookups, literals and `|| && == != !`; anything else (e.g. `format()`) keeps the raw text as the group.
- Artifacts work between jobs of the same run (act's artifact server, stored in the run directory and removed afterwards). `actions/cache` uses act's built-in cache server, which persists on each workflow server.
- Not done: job-level `concurrency`, persisting artifacts for download from the UI, and log retention/cleanup for old runs.

## Phase 5: Scale and providers

- Server side of the Gitea runner protocol so `act_runner` on each workflow server polls for individual jobs: per-job distribution across servers, label routing, runners behind NAT.
- Provider adapters (GitLab, Gitea, Bitbucket) normalizing webhook payloads into the GitHub event shape act expects.

## Dokploy-specific actions

Same syntax in `.dokploy/workflows`, plus first-party actions, starting with:

- `dokploy/deploy@v1` with `applicationId` / `composeId`: queue a Dokploy deployment, wait, fail the step if it fails.
