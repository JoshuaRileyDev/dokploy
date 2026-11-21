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

# Docker's built-in builder pushes through containerd's HTTP client, which gives up
# 30s after a layer is sent. The registry commits large layers to R2 more slowly
# than that, so push from a standalone BuildKit, which waits for the response.
# The workflow uses a fresh DOCKER_CONFIG per run, so keep builder state elsewhere.
export BUILDX_CONFIG="${BUILDX_CONFIG:-$HOME/.docker/buildx}"
BUILDER="${BUILDX_BUILDER:-dokploy-push}"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
	docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

docker buildx build \
	--builder "$BUILDER" \
	--progress=plain \
	--platform "${BUILD_PLATFORM:-linux/amd64}" \
	--pull \
	--tag "$IMAGE" \
	--file Dockerfile \
	--push \
	.
