FROM node:22-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm build
# Bundle the server with its production node_modules and built workspace deps
# (registry data, detector dist, migrations all travel with their packages).
RUN pnpm --filter @crawlytics/server deploy --legacy --prod /out

# The Stripe issuer (payment + license signing) runs ONLY on our side — never
# ship it in a distributed image. (Built separately via deploy/issuer.Dockerfile.)
RUN rm -rf /out/dist/issuer /out/dist/stripe-webhook.*

# Variant B: the dashboard SPA ships in the full (paid) image and is omitted from
# the headless (free OSS) image. The server already gates on whether public/ exists.
ARG INCLUDE_DASHBOARD=1
RUN if [ "$INCLUDE_DASHBOARD" = "1" ]; then cp -r /app/apps/web/dist /out/public; fi

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /out ./

EXPOSE 3000

CMD ["node", "dist/index.js"]
