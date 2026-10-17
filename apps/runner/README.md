# @joshuarileydev/dokploy-runner

Runs [Dokploy](https://dokploy.com) workflow jobs on a machine you own, for example a Mac for iOS and macOS builds.

The runner polls Dokploy over HTTPS for runs whose `runs-on` labels match its own, runs them with [act](https://github.com/nektos/act), and streams the output back. Dokploy never connects to the runner, so it works behind NAT without open ports.

## Requirements

- Node.js 20 or newer
- [act](https://github.com/nektos/act) on `PATH` (`brew install act`)
- Docker, only if the runner should also take Linux (`ubuntu-*`) jobs

## Setup

1. In Dokploy, open **Workflows → Runners → Add Runner**, choose a name and labels (for example `macos-latest`), and copy the registration token.
2. Install and register:

   ```sh
   npm install -g @joshuarileydev/dokploy-runner
   dokploy-runner register --url https://dokploy.example.com --token <registration-token>
   ```

3. Start it:

   ```sh
   dokploy-runner start
   ```

   Or keep it running in the background, including after reboots (launchd on macOS, systemd on Linux):

   ```sh
   dokploy-runner install-service
   ```

## How jobs run

- Labels that aren't Linux runner images (such as `macos-latest`) run directly on the machine, as the user running `dokploy-runner`, with access to Xcode, the keychain and signing certificates. Only connect machines you trust to repositories you trust; Dokploy never sends runs from untrusted sources (such as fork pull requests) to runners.
- `ubuntu-*` labels run in Docker containers if Docker is available.
- One run at a time. Secrets are delivered only for the run being executed, are masked in the output before it leaves the machine, and are deleted when the run finishes.

## Commands

| Command | |
|---|---|
| `register --url <url> --token <token> [--work-dir <dir>]` | Exchange a registration token for this runner's credential |
| `start [--once] [--verbose]` | Poll for runs; `--once` exits after one run, `--verbose` echoes job output |
| `status` | Show the saved configuration and act version |
| `install-service` / `uninstall-service` | Manage the background service |

The configuration (including the runner's credential) is saved with owner-only permissions at `~/.config/dokploy-runner/config.json`; use `--config <path>` or `DOKPLOY_RUNNER_CONFIG` to run several runners on one machine.

## Publishing

The package is private (`publishConfig.access: restricted`):

```sh
pnpm --filter @joshuarileydev/dokploy-runner publish
```
