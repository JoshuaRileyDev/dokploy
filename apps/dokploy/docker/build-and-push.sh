#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

IMAGE="${REGISTRY_IMAGE:?Set REGISTRY_IMAGE to the private registry image, including its tag}"
EXAMPLE_ENV="apps/dokploy/.env.production.example"

if ! docker info >/dev/null 2>&1; then
	printf 'Docker is unavailable. Start Docker Desktop or another Docker daemon and retry.\n' >&2
	exit 1
fi

if [[ ! -f .env.production ]]; then
	cp "$EXAMPLE_ENV" .env.production
	printf 'Created .env.production from %s\n' "$EXAMPLE_ENV"
fi

if [[ ! -f apps/dokploy/.env.production ]]; then
	cp "$EXAMPLE_ENV" apps/dokploy/.env.production
	printf 'Created apps/dokploy/.env.production from %s\n' "$EXAMPLE_ENV"
fi

docker buildx build \
	--platform linux/arm64 \
	--pull \
	--tag "$IMAGE" \
	--file Dockerfile \
	--push \
	.
