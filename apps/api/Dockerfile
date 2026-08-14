# syntax=docker/dockerfile:1.7
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build
ARG RELEASE_SHA
ARG RAILWAY_GIT_COMMIT_SHA
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/testing/package.json packages/testing/package.json
RUN test "$(node --version)" = "v22.22.2" && test "$(npm --version)" = "10.9.7" && npm ci
COPY apps/api apps/api
COPY packages packages
COPY infra/scripts/build-node-service.mjs infra/scripts/build-node-service.mjs
COPY infra/scripts/foundation-gate-lib.mjs infra/scripts/foundation-gate-lib.mjs
RUN SYNTHOLO_BUILD_PROVIDER=railway RELEASE_SHA="$RELEASE_SHA" RAILWAY_GIT_COMMIT_SHA="$RAILWAY_GIT_COMMIT_SHA" npm run build -w @syntholo/api
RUN SYNTHOLO_BUILD_PROVIDER=railway RELEASE_SHA="$RELEASE_SHA" RAILWAY_GIT_COMMIT_SHA="$RAILWAY_GIT_COMMIT_SHA" npm run build:migrate

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS migration-runtime
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision="$RELEASE_SHA" \
      org.opencontainers.image.source="https://github.com/syntholo/syntholo"
RUN groupadd --gid 10001 syntholo && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin syntholo \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/dist/migrate.js /app/migrate.js
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["/app/migrate.js"]

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS api-runtime
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision="$RELEASE_SHA" \
      org.opencontainers.image.source="https://github.com/syntholo/syntholo"
RUN groupadd --gid 10001 syntholo && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin syntholo \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/apps/api/dist/server.js /app/server.js
USER 10001:10001
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'4000')+'/v1/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["/app/server.js"]
