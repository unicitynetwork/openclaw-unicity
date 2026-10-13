# Docker gateway e2e image, built and driven by test/e2e/plugin-lifecycle-docker.test.ts (context: repo root).

# Stage 1: build and pack the plugin (the published tarball must contain dist/)
FROM node:24-bookworm-slim AS builder
WORKDIR /build
COPY package.json package-lock.json .npmrc tsconfig.json openclaw.plugin.json README.md LICENSE ./
RUN npm ci
COPY src/ src/
# .npmrc sets ignore-scripts=true, which also skips prepack — build explicitly.
RUN npm run build && npm pack

# Stage 2: OpenClaw gateway + plugin
FROM node:24-bookworm-slim
ARG OPENCLAW_VERSION=2026.10.2
# Build-time install and runtime gateway must agree on the state dir (~/.openclaw).
ENV HOME=/root NO_COLOR=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    npm install -g "openclaw@${OPENCLAW_VERSION}" --allow-scripts=openclaw && \
    openclaw --version
WORKDIR /app
COPY --from=builder /build/*.tgz ./
# Install the way a user would: the npm-pack tarball through the managed npm path (which, unlike --link,
# exposes missing runtime deps), non-interactively (--force confirms the non-ClawHub source,
# --accept-capabilities the capability consent). The entrypoint merges the run's config on top.
RUN set -eu; \
    set -- /app/*.tgz; \
    if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then echo "expected exactly one plugin tarball, found: $*" >&2; exit 1; fi; \
    mkdir -p "$HOME/.openclaw"; \
    printf '{ "gateway": { "mode": "local" } }\n' > "$HOME/.openclaw/openclaw.json"; \
    openclaw plugins install "npm-pack:$1" --force --accept-capabilities
COPY test/e2e/docker/entrypoint.sh test/e2e/docker/fake-model.mjs test/e2e/docker/write-config.mjs ./
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
