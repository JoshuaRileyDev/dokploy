# Cloud providers

Dokploy can create servers on a cloud provider, set them up over SSH and register them as remote servers. Each provider is an adapter behind one interface, so the database, API, provisioning flow and UI don't know which provider they're talking to.

| Layer | File |
|---|---|
| Contract (`CloudProviderDefinition`, `CloudProviderClient`, catalog types) | `packages/server/src/utils/cloud-providers/types.ts` |
| Registry | `packages/server/src/utils/cloud-providers/index.ts` |
| Hetzner adapter | `packages/server/src/utils/cloud-providers/hetzner.ts` |
| Monthly cost summary (matches provider servers to Dokploy servers by IP) | `packages/server/src/services/cloud-costs.ts` |
| Accounts and provisioning flow | `packages/server/src/services/cloud-provider.ts` |
| API (`cloudProvider.*`) | `apps/dokploy/server/api/routers/cloud-provider.ts` |
| Icons | `apps/dokploy/components/icons/cloud-provider-icons.tsx` |

## Adding a provider

1. Add its id to `cloudProviderTypes` in `types.ts`.
2. Create `<provider>.ts` exporting a `CloudProviderDefinition`:
   - `credentialFields` drives the connect form. Mark secrets with `secret: true`; they're encrypted at rest, masked in responses and kept when left blank on edit.
   - `sshUsername` is the user Dokploy connects as on new servers (`root` on Hetzner, `ubuntu` on most AWS images).
   - `createClient(credentials)` returns a `CloudProviderClient`. Map the provider's API into the shared catalog types: give server types a `family` (shown as tabs), prices per location and the catalog `currency`, and only return images Dokploy's setup script supports (Ubuntu, Debian).
   - Optionally implement `listServerCosts` to include the provider's servers in the monthly cost summary on the Servers page. Return every server in the account with its monthly price split into server, backups, primary IPs and volumes, using live prices from the provider's API.
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
