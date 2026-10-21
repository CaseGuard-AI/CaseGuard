# Production image for apps/web (Next.js standalone output). Build from the repo root:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://… -t caseguard-web .
FROM node:24-slim AS base
# Node 25+ no longer bundles corepack; install it so pnpm (package.json "packageManager") resolves.
RUN npm install -g corepack@latest && corepack enable
WORKDIR /repo

FROM base AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter @caseguard/web...
# Generated api.v1 types (packages/contracts/generated), committed and checked for drift in CI.
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @caseguard/web run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
