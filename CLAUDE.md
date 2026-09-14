# CLAUDE.md

Instrukcje dla Claude Code pracujacego w tym repo. Pelny opis architektury:
`README.md` (przeglad + status weryfikacji) i `ARCHITECTURE.md` (decyzje
projektowe + uzasadnienia, w tym Sekcja 10-11 - pivot z 3 aplikacji Nuxt na
jedna appke + Nuxt Modules). Ten plik to wylacznie praktyczne wskazowki
operacyjne.

## Co to jest

Sklep jako modularny monolit runtime: JEDNA aplikacja Nuxt (`apps/shop`),
skladajaca strony z niezaleznych **Nuxt Modules** (`modules/home`,
`modules/product`, `modules/cart` - build-time, `@nuxt/kit`), dziala jako
fiber JEDNEGO procesu Node orkiestrowanego przez `cordis@4.0.0-rc.8`. Modul i
uslugi backendowe komunikuja sie przez wspoldzielone koefekty (`cart`,
`product`, `features`), nie przez HTTP. `orchestrator/` bootstrapuje wszystko
z deklaratywnego `cordis.yml`.

## Komendy

```sh
pnpm install
pnpm --filter shop run build                                    # build jedynej apki
pnpm run start                                                  # caly system, port 8080
CORDIS_CONFIG=./cordis.dev.yml pnpm run start                   # + hot-reload apki (config.watch)
```

Test Dockera: `docker build -f deploy/docker/Dockerfile -t shop .`

## Kluczowe gotchas (odkryte empirycznie, nie zgaduj inaczej)

1. **`pnpm install` po dodaniu nowej zaleznosci workspace bywa niespojny -
   znana przyczyna (nie tylko "reinstall pomogl").** `@cordisjs/plugin-loader`
   rozwiazuje pakiety z `cordis.yml` przez naturalny `import()` Node.js
   WZGLEDEM WLASNEJ lokalizacji na dysku
   (`node_modules/.pnpm/@cordisjs+plugin-loader@.../node_modules/...`), nie
   wzgledem katalogu projektu - Node idzie w gore az trafi na wspolna,
   splaszczona pule `node_modules/.pnpm/node_modules/` (pnpm), gdzie swiezo
   dodany pakiet `@shop/*` moze jeszcze nie istniec mimo poprawnego symlinku
   w `node_modules/@shop/*` samego pakietu, ktory go importuje. Objaw: albo
   `ERR_MODULE_NOT_FOUND`, albo (gorzej) CICHY exit kodem 0 bez zadnego bledu
   w logach, bo `@cordisjs/plugin-include`/loader polyka blad importu
   pojedynczego wpisu. Napraw: (a) upewnij sie, ze nowy pakiet `@shop/*` jest
   jawnie dodany jako zaleznosc w `package.json` KAZDEGO pakietu, ktory go
   `inject`-uje (samo wymienienie w `cordis.yml` NIE wystarcza), (b) zrob
   pelny reinstall: `rm -rf node_modules packages/*/node_modules
   services/*/node_modules modules/*/node_modules apps/*/node_modules
   orchestrator/node_modules && pnpm install`. Oba kroki sa konieczne razem -
   patrz `ARCHITECTURE.md#shared-state` po pelny przebieg debugowania.

2. **`ctx.effect()` wymaga zwrocenia FUNKCJI, nie obiektu z metoda `.dispose`.**
   Kazdy disposer zwracany z `ctx.effect(...)` musi byc wywolywalny
   bezposrednio (`() => resource.dispose()`), nie samym obiektem majacym
   metode `.dispose()` - inaczej `TypeError: Invalid effect`.

3. **Nitro (`server/plugins/*`) uruchamia sie SYNCHRONICZNIE przy imporcie
   modulu, ZANIM wlasny shim `globalThis._importMeta_` (ktorego Nitro uzywa
   do przepisania `import.meta.url` w zbundlowanym kodzie) zdazy sie ustawic.**
   `getCordisContext(import.meta.url)` (patrz `packages/shared/src/bridge.ts`)
   wolane z `server/plugins/*` zawsze zawiedzie ("brak id w URL"), mimo ze
   `@shop/nuxt-wrapper` juz ustawil bridge PRZED `import()`. Rozwiazanie:
   kod potrzebujacy bridge'a musi zyc w handlerze wywolywanym PER REQUEST
   (`server/api/*.ts`, `server/middleware/*.ts`), nigdy w ciele
   `defineNitroPlugin(...)` - patrz `apps/shop/server/middleware/feature-gate.ts`
   (rejestruje manifest leniwie, przy pierwszym requescie) i
   `ARCHITECTURE.md#plugin-import-meta-gotcha`.

4. **`nitro.preset: 'node-listener'`** (NIE domyslny `node-server`!) w
   `apps/shop/nuxt.config.ts` - inaczej zbudowany plik sam probuje otworzyc
   wlasny `http.Server` na `process.env.PORT` przy imporcie (koliduje z
   `@shop/nuxt-wrapper`, ktory sam zarzadza `http.Server`).

5. **TypeScript w `packages/*`, `services/*` i `orchestrator/` = natywny Node
   type-stripping, ZERO buildu.** Nie uzywaj: `enum`, parameter properties w
   konstruktorach (`constructor(private x)`), importow wzglednych bez `.ts`.
   `apps/*` (Nuxt/Vite/esbuild) I `modules/*` (Nuxt Modules, ladowane przez
   jiti wewnatrz builda `apps/shop`) NIE maja tych ograniczen - pelny TS jak
   zwykle.

6. **Dosc niewinnie wygladajacy literal `modules/*/src/module.ts` w
   komentarzu `/** ... */` UCINA komentarz w polowie** (sekwencja `*/` po
   `modules/*` jest interpretowana jako koniec komentarza blokowego przez
   esbuild) - zaobserwowane 2x w tej sesji (`Expected ";" but found "..."`
   przy budowie `apps/shop`). Pisz `modules/<id>/src/module.ts` (bez `*`) albo
   uzywaj `//` zamiast `/** */`, kiedy komentarz wspomina sciezke z gwiazdka.

7. **Port 8080 moze kolidowac z innymi projektami na tej maszynie** (raz
   kolidowal z niezwiazanym projektem `prawniczkawpracy`). Sprawdz
   `lsof -nP -iTCP:8080 -sTCP:LISTEN` przed testami i NIGDY nie zabijaj
   procesu bez sprawdzenia, czyj jest.

8. **`@shop/nuxt-wrapper` domyslnie binduje do `127.0.0.1`, nie
   `0.0.0.0`.** Poprawne dla instancji ukrytej za brokerem (historyczny
   model 3 apek), ale `shop` w `cordis.yml`/`cordis.dev.yml` jest TERAZ
   jedynym publicznie eksponowanym portem calego systemu (broker usuniety,
   patrz ARCHITECTURE.md#11) - MUSI miec jawne `host: 0.0.0.0`, inaczej
   Docker/Kubernetes odrzuca KAZDE polaczenie z zewnatrz (kontener/pod
   laczy sie przez wlasny interfejs sieciowy, nie przez loopback). Lokalny
   `curl localhost:8080` dziala niezaleznie od tego ustawienia, wiec ten
   bug NIGDY nie ujawni sie w testach z tej samej maszyny - sprawdzaj
   `lsof`/`ss` (powinno pokazac `*:8080`, nie `127.0.0.1:8080`), nie tylko
   `curl`.

9. **Manifest `routes` w kazdym `modules/*/src/module.ts` MUSI wymieniac
   WSZYSTKIE wlasne sciezki - strone ORAZ kazdy wlasny `addServerHandler`**,
   nie tylko prefiks strony. `services/feature-registry-service` gatuje
   WYLACZNIE sciezki wymienione w `routes`; pominiecie API sprawia, ze
   `disable(id)` chowa strone, ale zostawia jej API w pelni dzialajace
   (dokladnie taki bug zgloszony i naprawiony w tej sesji w `modules/product`
   i `modules/cart`). Uzywaj `registerShopFeature()` z
   `@shop/shared/feature-manifest`, nie recznego pusha do `runtimeConfig.shopFeatures`.

## Gdzie czego szukac

- Nowy modul Nuxta (strona/sekcja sklepu): skopiuj strukture `modules/cart`
  (`src/module.ts` + `src/runtime/pages`/`src/runtime/server`), dopisz
  `'@shop/module-<id>'` do listy `modules` w `apps/shop/nuxt.config.ts` oraz
  `"@shop/module-<id>": "workspace:*"` do `apps/shop/package.json`. Zero
  zmian w `packages/*`/`cordis.yml` - modul wchodzi do gry przy nastepnym
  `pnpm --filter shop run build`. Pelny przyklad: `deploy/checkout-module-plan.md`.
- Nowy koefekt (cos, co inny komponent bedzie `inject`-owal): nowy pakiet w
  `services/`, klasa `extends Service` (wzor: `services/cart-service`), wpis
  w `cordis.yml`. `packages/` jest dla kodu BEZ cyklu zycia Cordisa (zwykle
  biblioteki, np. `packages/shared`) LUB komponentow Cordisa, ktore niczego
  nie dostarczaja innym (np. `packages/nuxt-wrapper` - nic go nie
  `inject`-uje) - `services/` tylko dla faktycznych dostawcow koefektow.
- Wlaczanie/wylaczanie juz-zbudowanego modulu bez rebuildu:
  `services/feature-registry-service` (koefekt `features`) - patrz
  `ARCHITECTURE.md#feature-registry`.
- Deployment: `deploy/README.md`.

## Status i ograniczenia

Patrz `README.md#status-weryfikacji`. W skrocie: lokalny dev i Docker sa
faktycznie uruchomione i sprawdzone. Manifesty Kubernetes (`deploy/k8s/`) i
pipeline CI (`deploy/workflows/build-and-push.yml`) sa napisane, ale NIE
uruchomione end-to-end na prawdziwym klastrze/rejestrze w tej sesji (brak
danych uwierzytelniajacych) - zweryfikuj przed produkcyjnym uzyciem, patrz
`deploy/README.md#kubernetes`. Czwarty modul (`modules/checkout`) jest tylko
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
kodu przez siec. Jedyny mechanizm "runtime bez rebuildu" to WLACZANIE/
WYLACZANIE kodu juz obecnego w buildzie (`services/feature-registry-service`),
nigdy wprowadzanie nowego kodu.
