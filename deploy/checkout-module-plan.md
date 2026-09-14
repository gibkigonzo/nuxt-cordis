# Plan: czwarty modul (`modules/checkout`)

Ten dokument opisuje **plan**, nie implementacje. Modul `checkout` celowo NIE
jest jeszcze zbudowany. Od wersji z JEDNA appka Nuxt (`apps/shop`, patrz
`ARCHITECTURE.md#10`) jego dodanie ma posluzyc jako zywa demonstracja DWOCH
odrebnych mechanizmow, nie jednego:

1. **Build-time**: nowy modul Nuxta wchodzi do `apps/shop` przez normalny
   rebuild + rolling update - dokladnie tak samo jak kazda inna zmiana kodu.
2. **Runtime, bez rebuildu**: modul moze zostac WGRANY, ale WYLACZONY (przez
   `services/feature-registry-service`), a nastepnie WLACZONY pozniej -
   `PATCH` stanu w pamieci procesu, zero nowego builda/deploymentu. To jest
   dokladny odpowiednik "dodania funkcjonalnosci w trakcie zycia frontendu"
   bez ladowania niezweryfikowanego kodu (patrz `ARCHITECTURE.md#8` po
   uzasadnienie, dlaczego druga sciezka - zdalne pobieranie kodu w runtime -
   zostala celowo usunieta).

## 1. Zakres funkcjonalny

Prosta strona podsumowania zamowienia:

- odczytuje biezacy koszyk przez koefekt `cart` (`ctx.get('cart').snapshot(cartId)`),
- pokazuje pozycje + sume,
- przycisk "potwierdz zamowienie" wywoluje `ctx.get('cart').clear(cartId)` i pokazuje
  ekran potwierdzenia (bez prawdziwej platnosci — to demo architektury, nie sklepu
  produkcyjnego).

## 2. Struktura plikow (docelowa)

```
modules/checkout/
├── package.json              # deps: @nuxt/kit, @shop/shared (workspace)
├── tsconfig.json
└── src/
    ├── module.ts              # defineNuxtModule - patrz modules/cart/src/module.ts
    └── runtime/
        ├── pages/index.vue    # widok podsumowania + potwierdzenia
        └── server/api/
            ├── summary.get.ts    # ctx.get('cart').snapshot(cartId)
            └── confirm.post.ts   # ctx.get('cart').clear(cartId) + zwrocenie potwierdzenia
```

Zero nowego kodu po stronie Cordis (`@shop/nuxt-wrapper`, `@shop/cart-service`,
`@shop/feature-registry-service`) - czwarty modul korzysta z DOKLADNIE tych
samych, juz istniejacych komponentow, co jest calym sensem demonstracji:
generyczny wrapper (jedna appka, jeden fiber) + reaktywny rejestr feature'ow,
zero kodu specyficznego dla "modulu nr 4".

## 3. Rejestracja w `apps/shop`

`modules/checkout/src/module.ts` wyglada analogicznie do `modules/cart/src/module.ts`
(patrz ten plik po pelny wzorzec), z jedna roznica - startuje WYLACZONY:

```ts
import { registerShopFeature } from '@shop/shared/feature-manifest'

registerShopFeature(nuxt.options, {
  id: 'checkout',
  // WAZNE: strona ORAZ oba server routes ponizej (summary.get.ts,
  // confirm.post.ts) - pominiecie ktoregokolwiek z nich oznaczaloby, ze
  // disable('checkout') chowa strone, ale zostawia API w pelni dzialajace
  // (dokladnie ten blad zgloszony i naprawiony w modules/cart i
  // modules/product w tej sesji, patrz ARCHITECTURE.md#feature-registry).
  routes: ['/checkout', '/api/summary', '/api/confirm'],
  enabled: false,
})
```

Wpis w `apps/shop/nuxt.config.ts` (dodawany, nie modyfikujacy istniejacych):

```ts
modules: [
  '@shop/module-home',
  '@shop/module-product',
  '@shop/module-cart',
  '@shop/module-checkout',   // <- nowy wpis
],
```

I `"@shop/module-checkout": "workspace:*"` w `apps/shop/package.json`.

## 4. Sekwencja demonstracji

### Faza A - build-time (normalny deployment)

1. `pnpm --filter shop run build` - buduje CALA appke NA NOWO (to jest znany,
   uczciwie przyznany kompromis modelu z jedna appka - patrz `ARCHITECTURE.md#10`
   i punkt "Kompromis" nizej), teraz zawierajaca skompilowany, ale wylaczony
   modul `checkout`.
2. Normalny `git push` -> CI buduje nowy obraz -> rolling update (patrz
   `deploy/README.md#kubernetes`) - zero pobierania/rozpakowywania kodu przez
   siec w dzialajacym procesie.
3. `/checkout` odpowiada `404` (modul jest w buildzie, ale `enabled: false`
   w `services/feature-registry-service`) - sesje uzytkownikow na `/product`
   czy `/cart` nie widza zadnej zmiany.

### Faza B - runtime, bez rebuildu

4. Operator wywoluje `ctx.get('features').enable('checkout')` (np. z wlasnego,
   zabezpieczonego panelu admina - celowo NIE zaimplementowanego tutaj, zeby
   nie dodawac publicznego, niezabezpieczonego API do wlaczania funkcji -
   patrz "Czego to demo NIE dodaje" nizej).
5. Kolejny request do `/checkout` trafia juz do dzialajacego, zbudowanego
   kodu - `services/feature-registry-service` trzyma `enabled`/`disabled` w
   Redis (koefekt `redis`, patrz ARCHITECTURE.md#shared-state), wiec
   przelaczenie jest natychmiastowe I widoczne od razu na WSZYSTKICH podach
   tego samego obrazu, nie tylko na tym, ktory obsluzyl `enable()`.
6. Sesje uzytkownikow aktualnie przegladajacych `/product` lub `/cart` NIE sa
   w ogole przerywane - `feature-gate` middleware sprawdza WYLACZNIE prefiks
   sciezki, ktory sie zmienia (`/checkout`), zaden inny stan nie jest ruszany.

## 5. Weryfikacja "bez przestoju"

Zweryfikowane empirycznie w tej sesji dla mechanizmu `enable`/`disable` na
module `cart` (jako dowod, ze mechanizm dziala - `checkout` bedzie
identyczny): `disable('cart')` -> `/cart` natychmiast `404`, `/product` i `/`
nadal `200`, ZADEN rebuild ani restart procesu. `enable('checkout')` dziala
lustrzanie odwrotnie.

Proponowany test manualny/skryptowany po zaimplementowaniu modulu (do dodania
jako `deploy/scripts/smoke-checkout.sh`): w petli co 200ms odpytywac
`GET /product` podczas wywolywania `enable('checkout')` i potwierdzic zerowa
liczbe bledow/timeoutow.

## 6. Kompromis: dlaczego to NIE jest to samo, co dawny `deploy.md`

Wczesniejszy (usuniety, patrz `ARCHITECTURE.md#8`) plan zakladal aktualizacje
POJEDYNCZEGO modulu bez rebuildu CALEGO systemu, przez pobieranie nowego kodu
z sieci. Model z jedna appka Nuxt (`apps/shop`) idzie w INNA strone: dodanie
NOWEGO kodu zawsze wymaga rebuildu calej appki (Faza A powyzej) - to jest
swiadomie przyjety kompromis modelu Nuxt Modules (patrz ARCHITECTURE.md#10,
"Kiedy Cordis naprawde uzyc"). To, co dziala BEZ rebuildu, to WYLACZNIE
przelaczanie widocznosci kodu, ktory JUZ przeszedl build+review+CI (Faza B) -
nigdy wprowadzanie nowego, niezweryfikowanego kodu do dzialajacego procesu.

## 7. Czego to demo NIE dodaje (celowo)

- Publicznego/niezabezpieczonego endpointu HTTP do wywolywania `enable()`/`disable()`
  - w tej sesji zweryfikowano mechanizm przez sygnal procesu (`kill -USR2`,
    tylko do testow lokalnych, NIE czesc zadnego commitowanego kodu) - realny
    panel admina wymagalby wlasnej autoryzacji, celowo poza zakresem tego demo.
- Nic dodatkowego tutaj - trwalosc stanu `enabled`/`disabled` miedzy podami
  (i miedzy restartami) jest juz zapewniona przez Redis (patrz punkt 5 wyzej
  i ARCHITECTURE.md#shared-state); `checkout` automatycznie dziedziczy ten
  sam mechanizm co `home`/`product`/`cart`, zero dodatkowej pracy.

## 8. Kiedy realizowac

Ten plan zostanie zrealizowany jako osobny, nastepny krok (na wyrazne polecenie),
PO uruchomieniu i zweryfikowaniu dzialania podstawowych trzech modulow
(`home`, `product`, `cart`) oraz warstwy deploymentu.
