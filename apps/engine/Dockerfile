# Build from the repo root:  docker build -f apps/engine/Dockerfile -t gremlin-engine .
# Run: docker run --rm -p 8080:8080 --env-file .env gremlin-engine
#
# Runtime: TypeScript is executed with tsx (no bundling step). Sibling workspace
# packages export TypeScript source (exports -> src/index.ts) and @gremlin/db reads its
# SQL migrations relative to its own source, so shipping the packages as-is and running
# them through tsx is the simplest robust option.
# The base image tag must match the pinned `playwright` version in apps/engine/package.json.

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS build
RUN corepack enable
# esbuild/msgpackr-extract install scripts are optional (prebuilt binaries / JS fallback); don't fail on them.
ENV pnpm_config_strict_dep_builds=false
WORKDIR /repo
COPY . .
RUN pnpm --filter @gremlin/engine deploy --prod /out

FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /out /app
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "src/main.ts"]
