# syntax=docker/dockerfile:1.6
# VanillaCore Agent Harness runtime image with a pinned Node 24 LTS base.
# Configuration is not baked in: VANILLACORE_HARNESS_HOME (harness.yaml, SOUL.md, state) and
# PI_CODING_AGENT_DIR (PI models.json/settings.json) come from volumes at run time.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
# Tools the agent's bash/read/edit tools commonly need; tini forwards SIGTERM so the
# harness can drain (restart_drain) before the pod is killed.
# Chromium runtime dependencies permit user-owned browser tooling without apt/sudo.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git jq openssh-client python3 ripgrep tini util-linux \
       libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
       libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
       libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
       libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
# Keep compiler/runtime additions in separate layers below common registry proxy
# upload limits. A single combined toolchain layer exceeds Cloudflare's limit.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev make \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ build-essential python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/vanillacore-harness
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY docs ./docs
COPY LICENSE ./LICENSE
ARG HARNESS_VERSION=0.1.0
ARG HARNESS_REVISION=0000000000000000000000000000000000000000
RUN HARNESS_VERSION="$HARNESS_VERSION" HARNESS_REVISION="$HARNESS_REVISION" node -e 'const fs=require("fs"); const version=process.env.HARNESS_VERSION, revision=process.env.HARNESS_REVISION; if(!/^\d+\.\d+\.\d+$/.test(version)|| !/^[a-f0-9]{40}$/.test(revision)) process.exit(1); fs.writeFileSync("build-info.json", JSON.stringify({version,revision}));'
LABEL org.opencontainers.image.version=$HARNESS_VERSION \
      org.opencontainers.image.revision=$HARNESS_REVISION
RUN ln -s /opt/vanillacore-harness/dist/cli.js /usr/local/bin/vanillacore-harness \
    && chmod 0755 dist/cli.js

# The image's node user is uid/gid 1000, same as the Hermes pods (fsGroup 1000).
USER 1000:1000
ENV HOME=/home/node \
    NPM_CONFIG_PREFIX=/home/node/.local \
    PATH=/home/node/.local/bin:$PATH \
    VANILLACORE_HARNESS_HOME=/home/node/.vanillacore-harness \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    API_SERVER_PORT=8642 \
    NODE_ENV=production
WORKDIR /home/node
EXPOSE 8642
ENTRYPOINT ["/usr/bin/tini", "--", "vanillacore-harness"]
CMD ["run"]
