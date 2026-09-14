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

1. **`pnpm install` po dodaniu nowej zaleznosci workspace bywa niespojny.**
   Jesli swiezo dodany pakiet `@shop/*` rzuca `ERR_MODULE_NOT_FOUND` mimo
   poprawnego symlinku w `node_modules`, zrob pelny reinstall:
   `rm -rf node_modules packages/*/node_modules services/*/node_modules
   modules/*/node_modules apps/*/node_modules orchestrator/node_modules &&
   pnpm install`. Zaobserwowane raz w tej sesji, przyczyna niejasna
   (prawdopodobnie cache resolvera pnpm), ale reinstall zawsze pomogl.

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
