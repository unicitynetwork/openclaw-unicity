# Stage 1: Pack the plugin
FROM node:22-slim AS builder
WORKDIR /build
COPY package.json openclaw.plugin.json .npmignore ./
COPY src/ src/
RUN npm pack

# Stage 2: Install OpenClaw + plugin
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    npm install -g openclaw@latest
WORKDIR /app
COPY --from=builder /build/*.tgz ./
COPY test/e2e/docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
