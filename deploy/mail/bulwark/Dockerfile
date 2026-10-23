# Bulwark 1.15.0 plus auto-sso.patch; built by build.sh from its exact source commit.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_LOCALE_PREFIX=always
ENV GIT_COMMIT=fc22f111-femboyz.5
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npx vitest run lib/auth/__tests__/auto-sso.test.ts lib/__tests__/web-push.test.ts stores/__tests__/auth-store-provider-logout.test.ts \
    'app/(main)/[locale]/auth/callback/__tests__/auto-sso.test.tsx' \
    'app/(main)/[locale]/login/__tests__/auto-sso.test.tsx' \
    components/auth/__tests__/auto-sso-screen.test.tsx \
    components/__tests__/pwa-install-prompt.test.tsx \
    components/mail/__tests__/mail-app-login-redirect.test.tsx
# Match upstream's production build: exclude mock JMAP and test-only imports.
RUN rm -rf app/api/dev-jmap && \
    find . -path ./node_modules -prune -o \
      \( -name __tests__ -o -name '*.test.ts' -o -name '*.test.tsx' \) \
      -prune -exec rm -rf {} \; && \
    npx next build --webpack

FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runner
LABEL org.opencontainers.image.title="femboyz Bulwark Webmail"
LABEL org.opencontainers.image.version="1.15.0-femboyz.5"
LABEL org.opencontainers.image.source="https://github.com/meadowlarps/femboyz-cloud-node/tree/main/deploy/mail/bulwark"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apk upgrade --no-cache && npm uninstall -g npm && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npx && \
    addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
RUN mkdir -p /app/data/settings /app/data/admin /app/data/admin-state /app/data/telemetry && chown -R nextjs:nodejs /app/data
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
