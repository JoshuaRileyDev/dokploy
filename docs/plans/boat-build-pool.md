# Boat build pool

Applications and compose services can build their images on a pool of [Boat](https://boat.dev) machines instead of a fixed build server. It uses the organization's Boat connection (`boat_settings`, see [workflows](./workflows.md#boat-sandboxes-done)). Self-hosted only.

Shipped as: migration `drizzle-fork/0011_boat_build_pool`; `services/boat-builds.ts`; router `boat.{buildMachines,saveBuildSettings,retryBuildMachine}`; the Builds section of Settings → Boat; a "Boat build pool" option under a service's Advanced → Build Server.

## How it works

- **Machines are build servers.** Each pool machine is a persistent Boat sandbox with a normal `server` row (role `build`, Dokploy-managed SSH key `Boat build pool`) and a `boat_build_machine` row. Setup runs the usual server setup for the build role, then the machine is stopped. Pool machines are hidden from the build server picker.
- **The service is assigned a machine per build.** A service with `boatBuildPool` (DB `forkBoatBuildPool`) and a build registry is queued on the `boat-builds:<organizationId>` partition, whose concurrency is the number of ready machines. When the job runs:
  1. A free machine is picked, preferring the one that last built this service, because it holds the Docker cache.
  2. The machine is resumed and its server row updated, since Boat gives it a new address on every resume.
  3. The machine is set as the service's `buildServerId` and the normal deploy path runs unchanged.
- **Afterwards:**
  - `buildServerId` is cleared.
  - Build logs are copied to the deploy server (or the Dokploy host) at the same path, and the deployment's `buildServerId` is cleared, so logs stay readable while the machine sleeps.
  - The machine is stopped after the configured idle time. Boat also auto-stops machines after 4 hours as a fallback.
- **Failures:** if no machine can be woken, the job records a failed deployment with the reason. A machine whose disk Boat deleted (stopped for over 14 days, or the sandbox is gone) is recreated and set up again on its next build.
- **Startup:** pool machines are stopped, and machines interrupted mid-setup are marked failed so they can be retried.

## Not yet handled

- Docker cache growth on machines (no automatic prune yet).
- Old build logs copied to a deploy server aren't removed when a compose service's old deployments are trimmed.
- Changing the machine size applies on each machine's next resume. Shrinking the pool only removes machines that aren't building.
