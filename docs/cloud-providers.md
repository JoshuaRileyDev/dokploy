# Cloud providers

Dokploy can create servers on a cloud provider, set them up over SSH and register them as remote servers. Each provider is an adapter behind one interface, so the database, API, provisioning flow and UI don't know which provider they're talking to.

| Layer | File |
|---|---|
| Contract (`CloudProviderDefinition`, `CloudProviderClient`, catalog types) | `packages/server/src/utils/cloud-providers/types.ts` |
| Registry | `packages/server/src/utils/cloud-providers/index.ts` |
| Hetzner adapter | `packages/server/src/utils/cloud-providers/hetzner.ts` |
| OVHcloud adapter (Public Cloud) | `packages/server/src/utils/cloud-providers/ovhcloud.ts` |
| DigitalOcean adapter | `packages/server/src/utils/cloud-providers/digitalocean.ts` |
| Vultr adapter | `packages/server/src/utils/cloud-providers/vultr.ts` |
| Contabo adapter | `packages/server/src/utils/cloud-providers/contabo.ts` |
| Provision Server flow | `packages/server/src/services/cloud-compare.ts`, `apps/dokploy/components/dashboard/settings/servers/provision-wizard.tsx` |
| Monthly cost summary (matches provider servers to Dokploy servers by IP) | `packages/server/src/services/cloud-costs.ts` |
| Accounts and provisioning flow | `packages/server/src/services/cloud-provider.ts` |
| API (`cloudProvider.*`) | `apps/dokploy/server/api/routers/cloud-provider.ts` |
| Icons | `apps/dokploy/components/icons/cloud-provider-icons.tsx` |

## Connecting an account

`handle-cloud-provider.tsx` connects a new account in three steps: choose the provider, enter credentials (checked with `cloudProvider.testConnection` before moving on, so errors show next to the fields), then name the account, with a suggested name that isn't taken. The provider's `credentialsHelp` sits collapsed above the fields. Editing an account is a single step, since the provider can't change.

## Adding a provider

1. Add its id to `cloudProviderTypes` in `types.ts`.
2. Create `<provider>.ts` exporting a `CloudProviderDefinition`:
   - `credentialFields` drives the connect form. Mark secrets with `secret: true`; they're encrypted at rest, masked in responses and kept when left blank on edit. Give a field `options` to render it as a select.
   - `sshUsername` is the user Dokploy connects as on new servers (`root` on Hetzner, `ubuntu` on most AWS images). If it depends on the image, return `sshUsername` from `createServer` as well (OVHcloud logs in as `ubuntu` or `debian`). A non-root user needs passwordless sudo, which Setup Server checks for.
   - `createClient(credentials)` returns a `CloudProviderClient`. Map the provider's API into the shared catalog types: give server types a `family` (shown as tabs), prices per location and the catalog `currency`, set `monthlyNet` when the prices you return include VAT (the comparison ranks providers before tax), and only return images Dokploy's setup script supports (Ubuntu, Debian).
   - Optionally implement `listServerCosts` to include the provider's servers in the monthly cost summary on the Servers page. Return every server in the account with its monthly price split into server, backups, primary IPs and volumes, using live prices from the provider's API.
   - If servers can only be cancelled for the end of a billing term, set `removal: "cancel"`. If they take longer than five minutes to start, set `bootTimeoutMs`.
   - Throw `CloudProviderError` with the right `kind` so the API returns a useful message. `deleteServer` and `deleteSshKey` must succeed if the resource is already gone.
3. Register it in `cloudProviders` in `index.ts`. TypeScript fails until steps 1 and 3 match.
4. Add an icon to `cloudProviderIcons`. Without one the UI shows a generic cloud icon.
5. Add an adapter test like `apps/dokploy/__test__/cloud-providers/hetzner.test.ts`.

No migration is needed. `providerType` is a text column checked against the registry, and credentials are stored as one encrypted JSON value.

## Provisioning flow

`startCloudServerProvisioning` records a `server_provisioning` row and runs in the background:

1. Generate an ed25519 key, store it in Dokploy and import it to the provider.
2. Create the server and poll `getServer` until it's `running`.
3. Wait for SSH, register the Dokploy server and run Setup Server.

If anything fails before the Dokploy server exists, the provider server and keys are deleted. If setup fails, the server is kept so the user can retry Setup Server.

`waitForServerProvisioning` follows a job until it finishes. The server migration dialog uses it to provision a new deploy server and then migrate onto it in one run (`transfer.startServer` with `provision`).

## OVHcloud

The adapter talks to the OVHcloud API (`/cloud/project/{projectId}/…`) with an application key, application secret and consumer key, signed the same way as the OVH DNS provider (`packages/server/src/utils/ovh/signing.ts`). The consumer key needs `GET`, `POST` and `DELETE` on `/cloud/project/*`; `GET /me` is optional and picks the price catalog for the account's subsidiary (otherwise FR, CA or US by endpoint).

- Flavor and image IDs differ per region, so the catalog uses names (`b3-8`, `Ubuntu 24.04`) and `createServer` resolves them in the chosen region.
- Prices come from the public order catalog by each flavor's hourly plan code. Instances are created with hourly billing, and monthly figures are 730 hours.
- Only general purpose, compute, memory, discovery and storage flavors are listed. Windows, GPU and bare-metal flavors need images Dokploy doesn't install on.
- The cost summary includes instances only. Block storage and backups are separate OVHcloud resources.

## DigitalOcean and Vultr

Both use a single API token and return sizes or plans with prices and the regions they're offered in, so they map directly onto the catalog. Prices are in USD before tax; `listServerCosts` reports the server price only.

- **DigitalOcean**: GPU sizes are skipped. Region slugs carry no location, so `LOCATIONS` maps them to cities.
- **Vultr**: plans can cost more in some regions (`location_cost`), which is reflected per location. GPU, free and block-storage-boot plans are skipped. A new instance only counts as running once it is active, powered on, `server_status` is `ok` and its IP is assigned. Vultr API keys are limited to an IP allow list, so the help text tells users to allow Dokploy's address.

## Provisioning a server

Provision Server walks through four steps, each narrowing the next, using every connected account's catalog (`cloudProvider.compare`):

1. **Size**: presets described by workload (Starter 1 vCPU / 2 GB up to Extra large 16 vCPU / 32 GB) or Custom minimums for vCPU, memory and disk, plus a CPU preference (any, x86, Arm). Each preset shows its lowest price and how many server types fit.
2. **Region**: a continent or Anywhere, each with its lowest price and option count for the chosen size.
3. **Server**: the cheapest fitting type from each account, so providers can be compared at a glance, with every option one click away. "Configure manually" opens the full create form with the choice preselected.
4. **Details**: name, role, exact location (with each city's price) and operating system, then Create.

Prices are compared before tax (`monthlyNet`) and converted with the European Central Bank's daily reference rates, cached for six hours; without rates they're shown in each provider's currency. Types without published specs (Contabo) can't be matched to a size, so they're only reachable through Configure manually. Providers without a connected account can be added from the first step.

## Contabo

The adapter logs in with the OAuth password grant (client ID, client secret, API user, API password from my.contabo.com/api/details) and sends the required `x-request-id` on every call. It differs from the other providers in three ways:

- **No catalog API.** Product IDs come from the table in Contabo's API docs, which only gives disk sizes. CPU and memory are filled in from instances already on the account, which also adds products the table doesn't list. Server types have `null` CPU, memory and prices when unknown, and the UI shows "–".
- **No prices.** The adapter doesn't implement `listServerCosts`, so Contabo servers are left out of the cost summary.
- **Cancel, not delete.** There is no DELETE for instances; `deleteServer` calls `/cancel`, which ends the contract at the end of the term (servers are created on a one-month term). The definition sets `removal: "cancel"`, so a failed provisioning keeps the server instead of cancelling it, and the UI says "Cancel" instead of "Delete". New servers can take 10 to 20 minutes, so `bootTimeoutMs` is 25 minutes. A server held for payment or account verification fails provisioning with that reason.

## Server migration

Migrating a server's services (Servers › … › Migrate) can target an existing server, the Dokploy server, or a new server provisioned as part of the migration. The plan (`transfer.planServer`) also reports:

- **CPU architecture.** `uname -m` on both servers, or the catalog's architecture for a server that doesn't exist yet. When they differ, `checkServicesArchitecture` (`packages/server/src/services/server-architecture.ts`) checks each service: apps built from source are rebuilt for the target unless a build server with the other CPU builds them, and prebuilt images (Docker-image apps, databases, compose services) are looked up with `docker manifest inspect -v` on the source. Services whose images have no build for the target are left unselected, and the user has to confirm the mismatch. Copied PostgreSQL data and volumes of stateful apps get a data warning. The single-service transfer dialog runs the same check (`transfer.checkArchitecture`).
- **What can't be moved automatically.** Domains that aren't in a Cloudflare zone Dokploy can edit, ports published directly on the old server's IP, server-level scheduled jobs and certificates, and anything configured on the old server outside Dokploy.

## Screenshots

`docs/screenshots/cloud-providers/` walks through the flow: connecting an account (choose provider, credentials, name), the four-step Provision Server flow (size, region, server, details), creating a server (including Contabo's cancel-only warning), provisioning progress, and migrating an Arm server's services onto a new x86 server with the CPU and manual-step warnings. They were taken against a local Dokploy with provider API responses stubbed: Vultr's catalog and OVHcloud's prices are real, while Hetzner, DigitalOcean and Contabo use sample values.
