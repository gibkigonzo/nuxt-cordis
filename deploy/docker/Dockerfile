# syntax=docker/dockerfile:1
#
# Deployment samohostowany (VM/Docker/Kubernetes) calego "modularnego monolitu
# runtime": jeden proces Node uruchamia orchestratora Cordis, ktory laduje
# uslugi, brame i trzy (docelowo wiecej) instancje Nuxt jako fibery w JEDNYM
# procesie. Zobacz deploy/README.md po alternatywny model (Cloudflare R2/KV +
# GitHub Actions, deploy.md) do publikowania POJEDYNCZYCH modulow bez rebuildu
# calego obrazu.

FROM node:24-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# --- warstwa zaleznosci (cache'owalna, zmienia sie tylko gdy zmienia sie lockfile) ---
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY orchestrator/package.json orchestrator/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/nuxt-wrapper/package.json packages/nuxt-wrapper/package.json
COPY packages/router-service/package.json packages/router-service/package.json
COPY packages/cart-service/package.json packages/cart-service/package.json
COPY packages/product-service/package.json packages/product-service/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY packages/remote-sync/package.json packages/remote-sync/package.json
COPY apps/home/package.json apps/home/package.json
COPY apps/product/package.json apps/product/package.json
COPY apps/cart/package.json apps/cart/package.json
RUN pnpm install --frozen-lockfile

# --- warstwa budowania (kompiluje wszystkie aplikacje Nuxt do .output/server) ---
FROM deps AS build
COPY . .
RUN pnpm --filter home --filter product --filter cart run build

# --- warstwa uruchomieniowa: tylko to, co potrzebne do wystartowania orchestratora ---
FROM base AS runtime
ENV NODE_ENV=production
ENV CORDIS_CONFIG=./cordis.yml

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/cordis.yml ./cordis.yml
COPY --from=build /app/orchestrator ./orchestrator
COPY --from=build /app/packages ./packages
# Tylko zbudowane wyjscia aplikacji (.output) sa potrzebne w runtime - zrodla
# Vue/nuxt.config.ts NIE sa potrzebne do uruchomienia, ale kopiujemy caly katalog
# apps/ dla prostoty (kazda apka i tak zawiera tylko wlasny .output + node_modules
# ktorych tu nie ma, bo pnpm trzyma je w korzeniu/.pnpm).
COPY --from=build /app/apps/home/.output ./apps/home/.output
COPY --from=build /app/apps/home/nuxt.config.ts ./apps/home/nuxt.config.ts
COPY --from=build /app/apps/product/.output ./apps/product/.output
COPY --from=build /app/apps/product/nuxt.config.ts ./apps/product/nuxt.config.ts
COPY --from=build /app/apps/cart/.output ./apps/cart/.output
COPY --from=build /app/apps/cart/nuxt.config.ts ./apps/cart/nuxt.config.ts

# Jedyny publicznie wystawiony port to brama (Service Broker) - porty
# poszczegolnych instancji Nuxt (3000-3002) nasluchuja domyslnie na 127.0.0.1
# i sa dostepne wylacznie wewnatrz procesu/kontenera (patrz packages/nuxt-wrapper).
EXPOSE 8080

# SIGTERM (np. `docker stop`) jest obslugiwany przez orchestrator/src/index.ts:
# kaskadowe ctx.fiber.dispose() zamyka wszystkie serwery HTTP w kolejnosci LIFO
# przed wyjsciem procesu.
CMD ["node", "--enable-source-maps", "orchestrator/src/index.ts"]
