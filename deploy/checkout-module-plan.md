# Plan: czwarty modul (`apps/checkout`)

Ten dokument opisuje **plan**, nie implementacje. Modul `checkout` celowo NIE jest
jeszcze zbudowany — jego dodanie do juz dzialajacego orchestratora ma posluzyc jako
zywa demonstracja przepiywu opisanego w `deploy.md`: nowy modul "dorasta" wewnatrz
zyjacego procesu, bez restartu `home`/`product`/`cart`.

## 1. Zakres funkcjonalny

Prosta strona podsumowania zamowienia:

- odczytuje biezacy koszyk przez koefekt `cart` (`ctx.get('cart').snapshot(cartId)`),
- pokazuje pozycje + sume,
- przycisk "potwierdz zamowienie" wywoluje `ctx.get('cart').clear(cartId)` i pokazuje
  ekran potwierdzenia (bez prawdziwej platnosci — to demo architektury, nie sklepu
  produkcyjnego).

## 2. Struktura plikow (docelowa)

```
apps/checkout/
├── package.json            # deps: nuxt, vue, vue-router, @shop/shared (dep), cordis (devDep)
├── nuxt.config.ts          # srcDir: '.', app.baseURL: '/checkout/', devServer.port: 3003,
│                            # nitro.preset: 'node-listener' (identycznie jak pozostale 3 appki)
├── app.vue                 # <NuxtPage />
├── pages/index.vue         # widok podsumowania + potwierdzenia
└── server/
    ├── utils/cart-id.ts    # ten sam wzorzec cookie 'cart_id' co w apps/product, apps/cart
    └── api/
        ├── summary.get.ts   # ctx.get('cart').snapshot(cartId)
        └── confirm.post.ts  # ctx.get('cart').clear(cartId) + zwrocenie potwierdzenia
```

Zero nowego kodu po stronie Cordis (`@shop/nuxt-wrapper`, `@shop/cart-service`,
`@shop/router-service`, `@shop/broker`) — czwarty modul korzysta z DOKLADNIE tych
samych, juz istniejacych komponentow, co jest calym sensem demonstracji (generyczny
wrapper + reaktywne koefekty, zero kodu specyficznego dla "instancji nr 4").

## 3. Wpis w `cordis.yml` (dodawany, nie modyfikujacy istniejacych)

```yaml
- id: checkout
  name: '@shop/nuxt-wrapper'
  config:
    id: checkout
    dir: ./apps/checkout
    port: 3003
    inject: ['cart', 'router']
    route: /checkout
```

## 4. Sekwencja demonstracji (zgodna z deploy.md)

1. `pnpm --filter checkout run build` — buduje TYLKO ten modul (Nitro `node-listener`
   preset -> `.output/server/index.mjs`), reszta appek pozostaje niedotknieta.
2. Dopisanie powyzszego wpisu do `cordis.yml` (lub, w wersji "produkcyjnej" z
   deploy.md, do configu odczytywanego z Cloudflare KV/R2 — patrz `deploy/README.md`).
3. `@cordisjs/plugin-include` + `@cordisjs/plugin-loader` wykrywaja zmiane pliku
   configu (`loader/config-update`), widza nowy `id: checkout` ktorego nie ma w
   pamieci -> `EntryGroup.create()` -> `ctx.registry.plugin()` -> nowy fiber.
4. Fiber `checkout` przechodzi `Inactive -> Reloading` i CZEKA (Theorem 63), bo
   deklaruje `inject: ['cart', 'router']` — obie sa juz aktywne (dostarczane przez
   `apps/cart`-niezalezny `@shop/cart-service` i `@shop/broker`), wiec aktywuje sie
   NATYCHMIAST, bez oczekiwania na restart czegokolwiek.
5. `@shop/nuxt-wrapper` importuje `.output/server/index.mjs`, otwiera `http.Server`
   na porcie 3003, rejestruje trase `/checkout` w `RouterService`.
6. Broker (juz dzialajacy, obslugujacy ruch do `/`, `/product`, `/cart`) od tej
   chwili poprawnie routuje `/checkout/*` — bez wlasnego restartu, bo `RouterService`
   jest reaktywnym koefektem, ktory broker odczytuje przy kazdym requescie.
7. Sesje uzytkownikow aktualnie przegladajacych `/product` lub `/cart` NIE sa w
   ogole przerywane (Corollary 62: fiber innych instancji sa nietkniete).

## 5. Weryfikacja "bez przestoju"

Proponowany test manualny/skryptowany (do dodania jako `deploy/scripts/smoke-checkout.sh`
gdy modul powstanie): w petli co 200ms odpytywac `GET /product` podczas wykonywania
kroku 2-6 powyzej i potwierdzic zerowa liczbe bledow/timeoutow w trakcie dodawania
czwartego modulu.

## 6. Kiedy realizowac

Ten plan zostanie zrealizowany jako osobny, nastepny krok (na wyrazne polecenie),
PO uruchomieniu i zweryfikowaniu dzialania podstawowych trzech modulow
(`home`, `product`, `cart`) oraz warstwy deploymentu.
