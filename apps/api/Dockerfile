# Production image for apps/api. Build from the repo root:
#   docker build -f apps/api/Dockerfile -t caseguard-api .
FROM node:24-slim AS base
# Node 25+ no longer bundles corepack; install it so pnpm (package.json "packageManager") resolves.
RUN npm install -g corepack@latest && corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @caseguard/api...
COPY apps/api apps/api
RUN pnpm --filter @caseguard/api run build \
 && pnpm --filter @caseguard/api deploy --prod --legacy /out

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
# Uploaded files (#101): the Compose `uploads` volume is mounted here. Created in the image so
# a new volume starts out owned by the user the api runs as.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
ENV UPLOADS_DIR=/data/uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Apply pending app-schema migrations as caseguard_app, then serve (ADR-0007).
CMD ["sh", "-c", "node dist/db/migrate.js up && exec node dist/server.js"]
