FROM node:24.11.1-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
ARG PITLANE_BUILD_SHA
ENV PITLANE_BUILD_SHA=$PITLANE_BUILD_SHA NEXT_TELEMETRY_DISABLED=1
RUN test -n "$PITLANE_BUILD_SHA" && pnpm build

FROM node:24.11.1-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24.11.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/.dist ./.dist
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
