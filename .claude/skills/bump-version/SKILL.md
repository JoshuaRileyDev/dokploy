---
name: bump-version
description: Bump the fork version as the final commit before pushing and opening a PR. Use for every change shipped from this repo, right before `git push` / `gh pr create`, and when syncing a new upstream Dokploy release.
allowed-tools: Bash, Read, Edit, Grep
---

Every change shipped from this fork bumps the version, so the running instance
shows which build is live. Do this **last**, just before pushing and creating
the PR.

## Where the version lives

`apps/dokploy/package.json` → `"version"`. It is the only place to change.

It's the single source of truth. The esbuild/Next build inlines it, and the
`settings.getDokployVersion` tRPC query returns it. The dashboard sidebar footer
renders that as "Version …" (`apps/dokploy/components/layouts/side.tsx`), and
the update checker reads it too (`getUpdateData` in
`packages/server/src/services/settings.ts`). Don't hard-code the version
anywhere else.

## Scheme

`v<upstream>-fork.<N>`, e.g. `v0.30.8-fork.3`.

- `<upstream>` is the upstream Dokploy release this fork is based on.
- `<N>` counts fork builds on top of that release, starting at 1.

Why this shape:

- Upstream never publishes `-fork.*` tags, so fork versions can't collide with
  upstream ones.
- It stays valid semver (`semver.clean` accepts it), so the update checker keeps
  working. `-fork.N` is a prerelease, so `v0.30.8-fork.N` sorts *below*
  upstream `v0.30.8` and below the next upstream release. Fork builds compare
  correctly among themselves (`fork.10` > `fork.2`).
- Don't use `+fork.N` (build metadata). Semver ignores it when comparing, and
  Docker tags can't contain `+`.

## Bump rule

Read the current value first:

```bash
node -p "require('./apps/dokploy/package.json').version"
```

- `vX.Y.Z-fork.N` → `vX.Y.Z-fork.<N+1>`
- plain `vX.Y.Z` (an upstream version, e.g. right after a merge) → `vX.Y.Z-fork.1`
- **Syncing a new upstream release** (merging upstream `vA.B.C`): `package.json`
  will conflict or take upstream's `vA.B.C`. Resolve it to `vA.B.C-fork.1`. The
  counter resets because the base changed.

If the branch is behind `fork` and someone bumped in the meantime, rebase or
merge first, then bump from the newest value. Never reuse a number that has
already shipped.

## Steps

1. Finish the work. Typecheck, lint and test as usual, and commit.
2. Bump the `"version"` line in `apps/dokploy/package.json` by hand. Don't run
   `npm version`/`pnpm version`, which also tag and touch other files.
3. Commit it on its own, as the final commit:

   ```bash
   git add apps/dokploy/package.json
   git commit -m "chore: bump version to vX.Y.Z-fork.N"
   ```

4. Push and open the PR against `fork` (`gh pr create --base fork`). Put the
   new version in the PR description.

## Confirming it's live after a deploy

1. Once the image is built and the Dokploy service updated, hard-refresh the
   dashboard.
2. The bottom of the sidebar (expanded) should read `Version vX.Y.Z-fork.N`.
   If it still shows the old value, the new image isn't running yet. Check
   with `docker service ps dokploy` and
   `docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'`.
3. The API gives the same value:
   `curl -s -H "x-api-key: $DOKPLOY_API_KEY" "$DOKPLOY_URL/api/settings.getDokployVersion"`.
