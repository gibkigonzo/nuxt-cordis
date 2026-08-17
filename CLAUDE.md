# CLAUDE.md

Instrukcje dla Claude Code pracujacego w tym repo. Pelny opis architektury:
`README.md` (przeglad + status weryfikacji) i `ARCHITECTURE.md` (decyzje
projektowe + uzasadnienia). Ten plik to wylacznie praktyczne wskazowki
operacyjne.

## Co to jest

Sklep jako modularny monolit runtime: 3 niezalezne aplikacje Nuxt (`apps/home`,
`apps/product`, `apps/cart`) dzialaja jako fibery JEDNEGO procesu Node,
orkiestrowane przez `cordis@4.0.0-rc.8`. Komunikuja sie przez wspoldzielone
koefekty (`cart`, `product`, `router`), nie przez HTTP. `orchestrator/`
bootstrapuje wszystko z deklaratywnego `cordis.yml`.

## Komendy

```sh
pnpm install
pnpm --filter home --filter product --filter cart run build   # build wszystkich apek
pnpm run start                                                  # caly system, port 8080
CORDIS_CONFIG=./cordis.dev.yml pnpm run start                   # + hot-reload apek (config.watch)
```

Build pojedynczej apki: `pnpm --filter product run build`.

Test Dockera: `docker build -f deploy/docker/Dockerfile -t shop .`

## Kluczowe gotchas (odkryte empirycznie, nie zgaduj inaczej)

1. **`pnpm install` po dodaniu nowej zaleznosci workspace bywa niespojny.**
   Jesli swiezo dodany pakiet `@shop/*` rzuca `ERR_MODULE_NOT_FOUND` mimo
   poprawnego symlinku w `node_modules`, zrob pelny reinstall:
   `rm -rf node_modules packages/*/node_modules apps/*/node_modules
   orchestrator/node_modules && pnpm install`. Zaobserwowane raz w tej sesji,
   przyczyna niejasna (prawdopodobnie cache resolvera pnpm), ale reinstall
   zawsze pomogl.

2. **`ctx.effect()` wymaga zwrocenia FUNKCJI, nie obiektu z metoda `.dispose`.**
   `@cordisjs/plugin-server`'s `ctx.server.all(...)` zwraca `HttpRoute` (ma
   `.dispose()`), NIE goly disposer - trzeba `return () => route.dispose()`,
   inaczej `TypeError: Invalid effect`.

3. **`path-to-regexp@8` (uzywany przez `@cordisjs/plugin-server`) NIE wspiera
   `(.*)`** (stary Express-style catch-all). Uzyj `'{/*splat}'` (dopasowuje
   tez goly `/`, sprawdzone empirycznie - patrz `packages/broker/src/index.ts`).

4. **Nitro respektuje `app.baseURL` WEWNETRZNIE i przekierowuje (302) kazdy
   request bez tego prefiksu.** Broker MUSI przekazywac sciezke BEZ ZMIAN
   (nie odcinac prefiksu) - patrz `ARCHITECTURE.md#4`.

5. **`nitro.preset: 'node-listener'`** (NIE domyslny `node-server`!) w
   `nuxt.config.ts` kazdej apki - inaczej zbudowany plik sam probuje otworzyc
   wlasny `http.Server` na `process.env.PORT` przy imporcie (kolizja portow
   przy wielu instancjach w jednym procesie).

6. **TypeScript w `packages/*` i `orchestrator/` = natywny Node type-stripping,
   ZERO buildu.** Nie uzywaj: `enum`, parameter properties w konstruktorach
   (`constructor(private x)`), importow wzglednych bez `.ts`. `apps/*`
   (Nuxt/Vite/esbuild) NIE ma tych ograniczen - pelny TS jak zwykle.

7. **Porty 3000/3001/3002/8080 moga kolidowac z innymi projektami na tej
   maszynie** (raz kolidowaly z niezwiazanym projektem `prawniczkawpracy`).
   Sprawdz `lsof -nP -iTCP:8080,3000,3001,3002 -sTCP:LISTEN` przed testami i
   NIGDY nie zabijaj procesu bez sprawdzenia, czyj jest.

## Gdzie czego szukac

- Nowa aplikacja Nuxt: skopiuj strukture `apps/cart`, dopisz wpis w
  `cordis.yml` (`name: '@shop/nuxt-wrapper'`, wlasny `port`/`route`/`inject`).
  Zero zmian w `packages/*` - wrapper jest generyczny. Pelny przyklad:
  `deploy/checkout-module-plan.md`.
- Nowy koefekt (usluga wspoldzielona): nowy pakiet w `packages/`, klasa
  `extends Service` (wzor: `packages/cart-service`), wpis w `cordis.yml`.
- Zmiana routingu brokera: `packages/router-service` (tabela tras) +
  `packages/broker` (proxy) - NIE hardkoduj portow poza `cordis.yml`.
- Deployment: `deploy/README.md`.

## Status i ograniczenia

Patrz `README.md#status-weryfikacji`. W skrocie: lokalny dev i Docker sa
faktycznie uruchomione i sprawdzone. Manifesty Kubernetes (`deploy/k8s/`) i
pipeline CI (`deploy/workflows/build-and-push.yml`) sa napisane, ale NIE
uruchomione end-to-end na prawdziwym klastrze/rejestrze w tej sesji (brak
danych uwierzytelniajacych) - zweryfikuj przed produkcyjnym uzyciem, patrz
`deploy/README.md#kubernetes`. Czwarty modul (`apps/checkout`) jest tylko
zaplanowany (`deploy/checkout-module-plan.md`), celowo niezaimplementowany.

**WAZNE:** wczesniejszy mechanizm `@shop/remote-sync` + Cloudflare R2/KV
(dynamiczne pobieranie i rozpakowywanie `.tar.gz` z kodem modulow w
dzialajacym procesie, bez weryfikacji integralnosci/sandboxa/autoryzacji)
zostal **celowo usuniety** ze wzgledow bezpieczenstwa - patrz
`ARCHITECTURE.md#8`. NIE przywracaj tego wzorca (dynamiczny `import()` z
URL-a obliczanego w runtime, `fetch()` + rozpakowanie archiwum na dysk
procesu produkcyjnego) bez wyraznej prosby uzytkownika i swiadomosci tych
kompromisow. Aktualny model: kod trafia do procesu WYLACZNIE przez build
obrazu (`deploy/docker/Dockerfile`) + deployment k8s (`deploy/k8s/`); cordis
pozostaje orchestratorem kodu juz zapieczonego w obrazie, nie dystrybutorem
kodu przez siec.
