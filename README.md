# nuxt-cordis-shop

Sklep zbudowany jako **modularny monolit runtime**: trzy (docelowo wiecej)
niezalezne aplikacje Nuxt, kazda budowana i wersjonowana osobno, dzialaja jako
**fibery jednego procesu Node** orkiestrowanego przez [Cordis](https://github.com/cordiverse/cordis)
— meta-framework spatiotemporal composability (rewersyjne efekty + reaktywne
koefekty). Zero kontenerow-na-uslugę, zero sieci miedzy modulami dzielacymi
stan, pelna izolacja bledow i hot-reload pojedynczej aplikacji bez przerywania
pozostalych.

Zbudowane w oparciu o [`docs/PlAn.md`](./docs/PlAn.md) (architektura) i
[`docs/deploy.md`](./docs/deploy.md) (model deploymentu). Zobacz
[`ARCHITECTURE.md`](./ARCHITECTURE.md) po pelny opis
decyzji projektowych i [`deploy/README.md`](./deploy/README.md) po przewodnik
wdrozenia (Docker oraz Cloudflare R2/KV + GitHub Actions).

## Struktura

```text
apps/home            Nuxt - strona glowna           (port 3000, /)
apps/product          Nuxt - katalog produktow        (port 3001, /product)
apps/cart              Nuxt - koszyk                    (port 3002, /cart)

packages/nuxt-wrapper   Cordis-owy wrapper: start/stop zbudowanej apki Nuxt
packages/cart-service   koefekt 'cart'    - stan koszyka w pamieci procesu
packages/product-service koefekt 'product' - katalog produktow
packages/router-service koefekt 'router'  - reaktywna tabela tras dla brokera
packages/broker         Service Broker (brama HTTP, jeden publiczny port)
packages/remote-sync    reconciler zdalnej konfiguracji (deploy.md)
packages/shared         wspoldzielone typy + "bridge" (patrz ARCHITECTURE.md)

orchestrator            bootstrapuje Context + Loader; caly skladu opisuje cordis.yml
cordis.yml               deklaratywna konfiguracja calego systemu (zrodlo prawdy)
deploy/                  Docker, GitHub Actions, Cloudflare Worker, skrypty
```

## Wymagania

- Node.js **24+** (dziala tez na 22.6+ dzieki natywnemu "type stripping", ale
  22 wypisuje eksperymentalne ostrzezenia - patrz `ARCHITECTURE.md#typescript`)
- pnpm 9 (`corepack enable` jesli nie masz)
- `tar` w PATH (uzywany przez `@shop/remote-sync` i skrypty deploymentu)

## Szybki start (lokalnie)

```sh
pnpm install

# zbuduj wszystkie trzy aplikacje Nuxt (Nitro preset "node-listener")
pnpm --filter home --filter product --filter cart run build

# uruchom caly system (jeden proces, jeden port publiczny: 8080)
pnpm run start
```

Nastepnie:

- <http://localhost:8080/> - strona glowna
- <http://localhost:8080/product> - katalog, "Dodaj do koszyka"
- <http://localhost:8080/cart> - koszyk (ten sam stan, inna aplikacja/build)

Zatrzymanie: `Ctrl+C` (SIGINT) lub `kill <pid>` (SIGTERM) - orchestrator
kaskadowo zamyka wszystkie fibery (LIFO) przed wyjsciem.

### Tryb deweloperski z hot-reloadem pojedynczej aplikacji

```sh
CORDIS_CONFIG=./cordis.dev.yml pnpm run start
```

W tym trybie kazda instancja Nuxt ma wlasny watcher (`config.watch: true` w
`cordis.dev.yml`) obserwujacy jej `.output/server/index.mjs`. W drugim
terminalu:

```sh
pnpm --filter product run build   # zmien kod, przebuduj
```

Orchestrator wykryje nowy build, zamknie i odtworzy WYLACZNIE fiber `product`
(dispose + reload) - `home` i `cart` nie sa dotykane, a stan `CartService`
(osobny fiber) przetrwa w calosci. Zweryfikowane empirycznie: podczas
przebudowy `product`, `curl /cart` przez caly czas zwraca `200` (0 przestoju).

## Deployment

Dwa udokumentowane, przetestowane wzgledem prawdziwego dzialania sciezki:

1. **Docker / self-hosted** (`deploy/docker/`) - jeden kontener, jeden proces,
   zweryfikowane `docker build` + `docker run` + `docker stop` (graceful
   shutdown). Patrz [`deploy/README.md`](./deploy/README.md#docker).
2. **Cloudflare R2/KV + GitHub Actions** (`deploy/workflows/`, `deploy/cloudflare/`)
   - dokladnie flow z `deploy.md`: build tylko zmienionego modulu, publikacja
     artefaktu na R2, aktualizacja manifestu w KV, orchestrator (dzialajacy na
     zwyklym hoscie Node - VM/Docker/Fly.io, NIE na samym Cloudflare Workers,
     patrz wyjasnienie w `ARCHITECTURE.md#cloudflare-workers`) odpytuje manifest
     i dodaje/aktualizuje/usuwa moduly na zywo przez `ctx.loader`.

## Status weryfikacji

Wszystko ponizej zostalo faktycznie uruchomione i sprawdzone w tym repo (nie
tylko zaprojektowane na papierze):

- [x] build + start 3 aplikacji, routing przez brokera, wspoldzielony stan koszyka
- [x] hot-reload pojedynczej aplikacji bez przestoju pozostalych (0/60 bledow w teście)
- [x] graceful shutdown (SIGTERM) - kaskadowe zamkniecie w kolejnosci LIFO
- [x] dynamiczne dodanie nowego modulu w locie przez `@shop/remote-sync` (bez restartu)
- [x] izolacja bledow: awaria jednej instancji nie wplywa na pozostale
- [x] `docker build` + `docker run` + `docker stop` calego systemu
- [ ] Cloudflare Worker (`deploy/cloudflare/manifest-worker`) - napisany wg
      dokumentowanego, poprawnego API Workers, ale NIE wdrozony/przetestowany
      na prawdziwym koncie Cloudflare w tej sesji (brak dostepnych danych
      uwierzytelniajacych) - patrz `deploy/README.md` po instrukcje weryfikacji
      przed uzyciem produkcyjnym

Czwarty modul (`apps/checkout`) jest celowo tylko zaplanowany, nie zbudowany -
patrz [`deploy/checkout-module-plan.md`](./deploy/checkout-module-plan.md).
