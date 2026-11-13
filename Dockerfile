FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/domain/package.json ./packages/domain/package.json
RUN npm ci --include=dev

COPY apps ./apps
COPY packages ./packages
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu tesseract-ocr tesseract-ocr-eng poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    BUDGETCENTS_WEB=/app/apps/web/dist \
    BUDGETCENTS_UPLOADS=/data/uploads \
    DEMO_LOGIN=false \
    SEED_DEMO=false \
    ALLOW_DEV_MAILSINK=false

# The API and shared package run TypeScript through tsx. Keep the workspace
# links and runtime loader installed; do not prune tsx as a dev dependency.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker/entrypoint.sh /usr/local/bin/budgetcents-entrypoint
RUN chmod 755 /usr/local/bin/budgetcents-entrypoint

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/budgetcents-entrypoint"]
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
