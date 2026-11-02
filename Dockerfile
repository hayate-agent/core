# syntax=docker/dockerfile:1.6
# Hayate Agent runtime image with a pinned Node 24 LTS base.
# Configuration is not baked in: HAYATE_AGENT_HOME (hayate-agent.yaml, SOUL.md, state) and
# PI_CODING_AGENT_DIR (PI models.json/settings.json) come from volumes at run time.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
    && npm rebuild @matrix-org/matrix-sdk-crypto-nodejs \
    && node --input-type=module -e 'await import("@matrix-org/matrix-sdk-crypto-nodejs")'
COPY tsconfig.json plugins.lock.json ./
COPY scripts ./scripts
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
WORKDIR /opt/hayate-agent
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY docs ./docs
COPY LICENSE ./LICENSE
ARG HAYATE_AGENT_VERSION=0.1.0
ARG HAYATE_AGENT_REVISION=0000000000000000000000000000000000000000
RUN HAYATE_AGENT_VERSION="$HAYATE_AGENT_VERSION" HAYATE_AGENT_REVISION="$HAYATE_AGENT_REVISION" node -e 'const fs=require("fs"); const version=process.env.HAYATE_AGENT_VERSION, revision=process.env.HAYATE_AGENT_REVISION; if(!/^\d+\.\d+\.\d+$/.test(version)|| !/^[a-f0-9]{40}$/.test(revision)) process.exit(1); fs.writeFileSync("build-info.json", JSON.stringify({version,revision}));'
LABEL org.opencontainers.image.version=$HAYATE_AGENT_VERSION \
      org.opencontainers.image.revision=$HAYATE_AGENT_REVISION
RUN ln -s /opt/hayate-agent/dist/cli.js /usr/local/bin/hayate-agent \
    && chmod 0755 dist/cli.js

# The image's node user is uid/gid 1000, same as the Hermes pods (fsGroup 1000).
USER 1000:1000
ENV HOME=/home/node \
    NPM_CONFIG_PREFIX=/home/node/.local \
    PATH=/home/node/.local/bin:$PATH \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    API_SERVER_PORT=8642 \
    NODE_ENV=production
WORKDIR /home/node
EXPOSE 8642
ENTRYPOINT ["/usr/bin/tini", "--", "hayate-agent"]
CMD ["run"]
