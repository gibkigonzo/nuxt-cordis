# syntax=docker/dockerfile:1
#
# Jedyny obraz systemu: jeden proces Node uruchamia orchestratora Cordis,
# ktory laduje uslugi backendowe (cart/product/features) i JEDNA instancje
# Nuxt (apps/shop, skladajaca modules/home, modules/product, modules/cart -
# Nuxt Modules, build-time, patrz ARCHITECTURE.md#10) jako fiber w tym samym
# procesie. Obraz jest niezmiennym artefaktem calego systemu - aktualizacja
# KAZDEGO modulu (w tym dodanie nowego, patrz deploy/checkout-module-plan.md)
# idzie przez rebuild tego obrazu i normalny rolling deployment (patrz
# deploy/k8s/ i deploy/README.md), NIE przez zdalne pobieranie/rozpakowywanie
# kodu w dzialajacym procesie.

FROM node:24-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# --- warstwa zaleznosci (cache'owalna, zmienia sie tylko gdy zmienia sie lockfile) ---
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY orchestrator/package.json orchestrator/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/nuxt-wrapper/package.json packages/nuxt-wrapper/package.json
COPY services/cart-service/package.json services/cart-service/package.json
COPY services/product-service/package.json services/product-service/package.json
COPY services/feature-registry-service/package.json services/feature-registry-service/package.json
COPY modules/home/package.json modules/home/package.json
COPY modules/product/package.json modules/product/package.json
COPY modules/cart/package.json modules/cart/package.json
COPY apps/shop/package.json apps/shop/package.json
RUN pnpm install --frozen-lockfile

# --- warstwa budowania (kompiluje JEDNA aplikacje Nuxt do .output/server) ---
FROM deps AS build
COPY . .
RUN pnpm --filter shop run build

# --- warstwa uruchomieniowa: tylko to, co potrzebne do wystartowania orchestratora ---
FROM base AS runtime
ENV NODE_ENV=production
ENV CORDIS_CONFIG=./cordis.yml

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/cordis.yml ./cordis.yml
COPY --from=build /app/orchestrator ./orchestrator
COPY --from=build /app/packages ./packages
COPY --from=build /app/services ./services
# UWAGA: modules/* (Nuxt Modules) sa zaleznoscia WYLACZNIE builda apps/shop -
# Rollup/Nitro bundluje ich kod bezposrednio do .output/server, wiec runtime
# NIE potrzebuje ich zrodel (w przeciwienstwie do packages/services, ktore
# orchestrator importuje bezposrednio jako wlasne komponenty Cordis).
# Tylko zbudowane wyjscie (.output) jest potrzebne w runtime - zrodla
# Vue/nuxt.config.ts NIE sa potrzebne do uruchomienia, ale kopiujemy caly
# katalog apps/shop dla prostoty.
COPY --from=build /app/apps/shop/.output ./apps/shop/.output
COPY --from=build /app/apps/shop/nuxt.config.ts ./apps/shop/nuxt.config.ts

# Jedyny publicznie wystawiony port to sama appka (jeden proces, jeden port) -
# Nuxt sam routuje wewnatrz siebie (patrz packages/nuxt-wrapper).
EXPOSE 8080

# Brak zapisu na dysku w runtime (caly kod jest juz w obrazie, zero pobierania
# czegokolwiek przez siec po starcie) - proces moze dzialac jako non-root user
# wbudowany w oficjalny obraz node:*.
USER node

# SIGTERM (np. `docker stop`, k8s przy rolling update) jest obslugiwany przez
# orchestrator/src/index.ts: kaskadowe ctx.fiber.dispose() zamyka wszystkie
# serwery HTTP w kolejnosci LIFO przed wyjsciem procesu.
CMD ["node", "--enable-source-maps", "orchestrator/src/index.ts"]
