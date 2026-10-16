ARG NODE_IMAGE=node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4

FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY web/ ./web/
RUN npm run build

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspaces=false --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG CLAUDE_CODE_VERSION=2.1.301
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

WORKDIR /opt/cchop
COPY package.json README.md AGENTS.md .env.example ./
COPY --from=dependencies /app/node_modules/ ./node_modules/
COPY --from=build /build/dist/ ./dist/
RUN chmod 755 dist/cli.js && ln -s /opt/cchop/dist/cli.js /usr/local/bin/cchop

ENV NODE_ENV=production \
    CCHOP_HOST=0.0.0.0 \
    CCHOP_ADMIN_HOST=0.0.0.0 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1
USER node
WORKDIR /home/node
RUN cchop --version && claude --version
EXPOSE 8787 8788
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["cchop", "start"]
