# syntax=docker/dockerfile:1.6
# VanillaCore Agent Harness runtime image: the harness (dist/) plus the PI SDK it embeds, on Node 22.
# Configuration is not baked in: VANILLACORE_HARNESS_HOME (harness.yaml, SOUL.md, state) and
# PI_CODING_AGENT_DIR (PI models.json/settings.json) come from volumes at run time.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim
# Tools the agent's bash/read/edit tools commonly need; tini forwards SIGTERM so the
# harness can drain (restart_drain) before the pod is killed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git jq openssh-client python3 ripgrep tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/vanillacore-harness
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
RUN ln -s /opt/vanillacore-harness/dist/cli.js /usr/local/bin/vanillacore-harness \
    && chmod 0755 dist/cli.js

# The image's node user is uid/gid 1000, same as the Hermes pods (fsGroup 1000).
USER 1000:1000
ENV HOME=/home/node \
    VANILLACORE_HARNESS_HOME=/home/node/.vanillacore-harness \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    API_SERVER_PORT=8642 \
    NODE_ENV=production
WORKDIR /home/node
EXPOSE 8642
ENTRYPOINT ["/usr/bin/tini", "--", "vanillacore-harness"]
CMD ["run"]
