# nuxt-cordis-shop

Sklep zbudowany jako **modularny monolit runtime**: JEDNA aplikacja Nuxt
(`apps/shop`), skladajaca strony/route'y z niezaleznych **Nuxt Modules**
(`modules/home`, `modules/product`, `modules/cart` - build-time, patrz
[`ARCHITECTURE.md#10`](./ARCHITECTURE.md)), dziala jako fiber JEDNEGO procesu
Node orkiestrowanego przez [Cordis](https://github.com/cordiverse/cordis) —
meta-framework spatiotemporal composability (rewersyjne efekty + reaktywne
koefekty). Uslugi backendowe (koszyk, katalog, rejestr feature'ow) sa
niezaleznymi koefektami Cordis wspoldzielonymi w pamieci procesu — zero
kontenerow-na-usluge, zero sieci miedzy komponentami dzielacymi stan, pelna
izolacja bledow i hot-reload calej appki bez restartu uslug backendowych.

**Ta wersja architektury jest wynikiem drugiej iteracji.** Pierwsza wersja
skladala sklep z TRZECH osobnych aplikacji Nuxt (kazda: wlasny port, wlasny
proces HTTP, wlasny build) spinanych brokerem HTTP. Zewnetrzna analiza
(zewnetrzne AI, wrzesien 2026 — patrz [`ARCHITECTURE.md#10`](./ARCHITECTURE.md))
wykazala, ze to nie jest wlasciwa warstwa dla granic modulow w Nuxcie: Nuxt
sam ma juz mechanizm build-time do skladania niezaleznie autorstwa czesci w
JEDNA appke (**Nuxt Modules**), a broker + osobne porty tylko duplikowaly to,
co router Nuxta juz robi. Broker (`@shop/broker`) i reaktywna tabela tras
(`@shop/router-service`) zostaly **usuniete** — patrz `git log` po historie
tej decyzji. Wczesniejszy plan deploymentu z [`docs/deploy.md`](./docs/deploy.md)
(dynamiczne pobieranie kodu modulow przez siec w dzialajacym procesie) rowniez
zostal **swiadomie porzucony ze wzgledow bezpieczenstwa** - patrz
[`ARCHITECTURE.md#8`](./ARCHITECTURE.md) po uzasadnienie. Zobacz
[`ARCHITECTURE.md`](./ARCHITECTURE.md) po pelny opis decyzji projektowych i
[`deploy/README.md`](./deploy/README.md) po przewodnik wdrozenia (Docker do
testow lokalnych, Kubernetes jako sciezka produkcyjna).

## Struktura

```text
apps/shop                  jedyna aplikacja Nuxt (port 8080) - skromny host,
                            zero wlasnych stron: kazda strona pochodzi z modulu

modules/home                Nuxt Module - strona glowna (trasa: /)
modules/product              Nuxt Module - katalog produktow (trasa: /product)
modules/cart                   Nuxt Module - koszyk (trasa: /cart)

services/cart-service         koefekt 'cart'    - stan koszyka (Redis Hash, wspoldzielony)
services/product-service       koefekt 'product' - katalog produktow
services/feature-registry-service koefekt 'features' - ktore moduly sa aktualnie wlaczone (Redis, wspoldzielony)
services/redis-service          koefekt 'redis'   - wspoldzielone polaczenie Redis (jedno per proces)

packages/nuxt-wrapper   Cordis-owy wrapper: start/stop zbudowanej apki Nuxt
packages/shared         wspoldzielone typy + "bridge" (patrz ARCHITECTURE.md)

orchestrator            bootstrapuje Context + Loader; caly skladu opisuje cordis.yml
cordis.yml               deklaratywna konfiguracja calego systemu (zrodlo prawdy)
deploy/                  Docker, manifesty Kubernetes, pipeline CI (GitHub Actions)
```

Rozroznienie `packages/` vs `services/` jest mechaniczne, nie "biznes vs infra":
`services/*` to komponenty Cordisa, ktore `provide`-uja koefekt WSTRZYKIWANY
przez cos innego (`cart-service`/`product-service`/`feature-registry-service` -
wszystkie trzy sa `inject`-owane w `apps/shop`). `packages/*` to reszta:
albo zwykle biblioteki bez cyklu zycia Cordisa (`shared`), albo komponenty
Cordisa, ktore SAME konsumuja koefekty, ale niczego nie dostarczaja innym
(`nuxt-wrapper` - nic go nie `inject`-uje). `modules/*` to osobna kategoria:
**Nuxt Modules** (`@nuxt/kit`), dzialajace WYLACZNIE podczas builda `apps/shop`
- nie sa komponentami Cordis w ogole, patrz `ARCHITECTURE.md#10`.

## Wymagania

- Node.js **24+** (dziala tez na 22.6+ dzieki natywnemu "type stripping", ale
  22 wypisuje eksperymentalne ostrzezenia - patrz `ARCHITECTURE.md#typescript`)
- pnpm 9 (`corepack enable` jesli nie masz)
- **Redis** (lokalnie: `redis-server` dostepny na `redis://127.0.0.1:6379`,
  domyslny adres jesli `REDIS_URL` nie jest ustawiony) - koefekt `redis`
  wymagany przez `CartService`/`FeatureRegistryService`, patrz sekcja
  "Wspoldzielony stan (Redis)" nizej
- Do deploymentu (nie do lokalnego dev): Docker (docker-compose uruchamia
  Redis automatycznie), oraz `kubectl`/`kustomize` jesli wdrazasz na
  Kubernetesie - patrz `deploy/README.md#kubernetes`

## Szybki start (lokalnie)

```sh
# Redis musi juz nasluchiwac przed startem orchestratora (koefekt 'redis'
# jest w cordis.yml przed nuxt-wrapper - patrz "Wspoldzielony stan" nizej)
redis-server --daemonize yes   # albo dowolny inny sposob uruchomienia Redis

pnpm install

# zbuduj JEDNA aplikacje Nuxt (Nitro preset "node-listener")
pnpm --filter shop run build

# uruchom caly system (jeden proces, jeden port publiczny: 8080)
pnpm run start
```

Nastepnie:

- <http://localhost:8080/> - strona glowna
- <http://localhost:8080/product> - katalog, "Dodaj do koszyka"
- <http://localhost:8080/cart> - koszyk (ten sam stan, inny modul Nuxta)

Zatrzymanie: `Ctrl+C` (SIGINT) lub `kill <pid>` (SIGTERM) - orchestrator
kaskadowo zamyka wszystkie fibery (LIFO) przed wyjsciem.

### Tryb deweloperski z hot-reloadem

```sh
CORDIS_CONFIG=./cordis.dev.yml pnpm run start
```

W tym trybie `apps/shop` ma wlasny watcher (`config.watch: true` w
`cordis.dev.yml`) obserwujacy caly katalog appki (w tym `modules/*`, bo
Rollup/Nitro bundluje ich kod bezposrednio w wynikowy plik). W drugim
terminalu:

```sh
pnpm --filter shop run build   # zmien kod (w apps/shop LUB w dowolnym modules/*), przebuduj
```

Podmiana jest zero-downtime, ale INACZEJ niz przed pivotem na jedna appke:
`@shop/nuxt-wrapper` otwiera JEDEN, trwaly `http.Server` raz i nigdy go nie
zamyka/otwiera ponownie - hot-reload podmienia WYLACZNIE wewnetrzna
referencje do funkcji obslugujacej request (atomowa podmiana zmiennej w
jednowatkowym JS). Zweryfikowane empirycznie w tej sesji: 200 requestow co
50ms obejmujacych caly cykl rebuildu - `0/200` bledow, caly czas dokladnie
jeden proces nasluchujacy na tym samym porcie (patrz ARCHITECTURE.md#5 po
uzasadnienie, dlaczego wczesniejszy model "nowy serwer na porcie
efemerycznym" - poprawny WYLACZNIE gdy broker przekierowywal ruch - po
usunieciu brokera psul caly system po pierwszym reloadzie). Stan uslug
backendowych (`CartService`, `ProductService`, `FeatureRegistryService` -
osobne fibery) przetrwa w calosci niezaleznie od podmiany appki.

## Wspoldzielony stan (Redis)

`deploy/k8s/deployment.yaml` ustawia `replicas: 2` - wiele podow tego samego
obrazu za jednym k8s Service (bez sticky sessions), wiec KOLEJNE requesty tego
samego uzytkownika moga trafic do RÓZNYCH podow. Dwa fragmenty stanu MUSZA
byc wiec spojne miedzy podami, nie per-proces:

- **koszyk** (`CartService`) - Redis Hash `shop:cart:<cartId>`, TTL 7 dni
  odswiezany przy kazdym zapisie
- **feature-toggle** (`FeatureRegistryService`) - Redis Hash
  `shop:features:enabled` - `enable(id)`/`disable(id)` wywolane na jednym
  podzie musi natychmiast obowiazywac na WSZYSTKICH

Trzeci fragment stanu `FeatureRegistryService` (manifest tras: ktory modul
odpowiada za ktora sciezke) zyje CELOWO lokalnie w pamieci kazdego poda - jest
identyczny wszedzie (ten sam obraz), wiec nie ma czego synchronizowac, a
trzymanie go lokalnie utrzymuje `resolve()` (wolane przy kazdym requescie)
szybkim, bez zapytania sieciowego na hot path routingu.

`services/redis-service` (koefekt `redis`) to jedno wspoldzielone polaczenie
`ioredis` per proces, z ktorego korzystaja oba serwisy powyzej
(`static inject = ['redis']`). Adres: `config.url` w `cordis.yml` (celowo
NIEustawiony - baked-in obraz nie moze zaszywac adresu per-srodowisko) albo
`REDIS_URL` (ustawiane per-srodowisko: `docker-compose.yml` ->
`redis://redis:6379`, `deploy/k8s/deployment.yaml` -> `redis://redis:6379`
wskazujace `deploy/k8s/redis-deployment.yaml`), z fallbackiem na
`redis://127.0.0.1:6379` dla lokalnego dev.

Zweryfikowane empirycznie w tej sesji przez symulacje dwoch podow (dwa
niezalezne procesy orchestratora na portach 8080/8081, ten sam Redis, ten sam
cookie jar): pozycja dodana do koszyka na porcie 8080 natychmiast widoczna i
laczona na porcie 8081, i odwrotnie; `disable('cart')` (zapis do Redis)
natychmiast gatuje `/cart` ORAZ `/api/cart` na OBU portach jednoczesnie.
Redis w `deploy/k8s/redis-deployment.yaml` to swiadomy kompromis: pojedynczy
pod bez PVC/replikacji (dane gina przy restarcie tego poda) - pelna
odpornosc (Sentinel/Cluster) to osobny, wiekszy projekt, patrz komentarz w
tym pliku.

## Skladanie/wylaczanie funkcjonalnosci bez rebuildu

Poza build-time (Nuxt Modules, wyzej), istnieje DRUGI, celowo odrebny
mechanizm: `services/feature-registry-service` (koefekt `features`) pamieta,
ktore z juz-zbudowanych modulow sa aktualnie wlaczone. To pozwala wgrac nowy
modul jako WYLACZONY (bezpieczny, zrewiewowany build), a potem wlaczyc go bez
rebuildu i bez restartu - `ctx.get('features').enable('checkout')` z
dowolnego miejsca majacego dostep do `ctx`. Kazdy modul deklaruje w
manifescie strone ORAZ kazdy wlasny server route - `disable(id)` gatuje
WSZYSTKIE z nich, nie tylko strone. Zweryfikowane empirycznie w tej sesji:
`disable('cart')` -> `GET /cart`, `GET /api/cart`, `POST /api/cart/remove`,
`POST /api/cart/clear` wszystkie natychmiast `404`, `GET /product`,
`POST /api/cart/add` i `GET /` nadal `200`, zero rebuildu, zero restartu
procesu. Pelny przyklad:
[`deploy/checkout-module-plan.md`](./deploy/checkout-module-plan.md).

**To NIE jest to samo, co usuniety `@shop/remote-sync`** (patrz
`ARCHITECTURE.md#8`): przelaczany jest WYLACZNIE kod, ktory juz przeszedl
build+review+CI i jest czescia tego samego, jednego `.output` — nigdy nowy,
niezweryfikowany kod pobierany z sieci.

## Deployment

Jedna sciezka: **buduj jeden niezmienny obraz Docker w CI, wdrazaj rolling
update'em w Kubernetesie.** Cordis pozostaje WYLACZNIE orchestratorem kodu
juz zapieczonego w obrazie - `cordis.yml` jest czytany raz przy starcie, zero
pobierania kodu przez siec w dzialajacym procesie.

1. **Docker** (`deploy/docker/`) - build calego systemu w jeden obraz, jeden
   proces, jeden port. Zweryfikowane `docker build` + `docker run` +
   `docker stop` (graceful shutdown). Ten sam obraz jest uzywany lokalnie
   (smoke test) i w Kubernetesie (produkcja). Patrz
   [`deploy/README.md`](./deploy/README.md#docker).
2. **Kubernetes** (`deploy/k8s/`, `deploy/workflows/build-and-push.yml`) -
   CI publikuje obraz (tag = git sha) do rejestru, `Deployment` z
   `RollingUpdate`/`maxUnavailable: 0`, readiness/liveness probe, non-root +
   `readOnlyRootFilesystem`. Rollback to standardowe `kubectl rollout undo`.
   Patrz [`deploy/README.md`](./deploy/README.md#kubernetes) i uzasadnienie
   w [`ARCHITECTURE.md#8`](./ARCHITECTURE.md) (dlaczego zastapilo to
   wczesniejszy model dynamicznego pobierania kodu przez siec).

## Status weryfikacji

Wszystko ponizej zostalo faktycznie uruchomione i sprawdzone w tym repo (nie
tylko zaprojektowane na papierze):

- [x] build + start JEDNEJ appki Nuxt (`apps/shop`), skladajacej strony z
      trzech Nuxt Modules, wspoldzielony stan koszyka miedzy nimi
- [x] koefekt `features` (rejestr modulow): `disable('cart')` -> strona
      ORAZ wszystkie jej server routes natychmiast `404` (inne moduly nadal
      `200`), bez rebuildu i bez restartu procesu; `register()` rzuca przy
      probie zarejestrowania przez dwa rozne moduly tej samej sciezki -
      zweryfikowane przez sygnal procesu w sesji deweloperskiej (nie czesc
      commitowanego kodu, patrz `deploy/checkout-module-plan.md#7`)
- [x] hot-reload calej appki bez przestoju: 200 requestow co 50ms
      obejmujacych caly cykl rebuildu, `0/200` bledow, caly czas jeden
      proces na tym samym porcie (dev-only mechanizm - `cordis.dev.yml`,
      patrz sekcja wyzej i ARCHITECTURE.md#5)
- [x] graceful shutdown (SIGTERM) - kaskadowe zamkniecie w kolejnosci LIFO
- [x] `docker build` + `docker run` + `docker stop` calego systemu
- [x] wspoldzielony stan Redis (`CartService`, `FeatureRegistryService`) -
      zweryfikowane przez symulacje dwoch podow (dwa procesy orchestratora
      na roznych portach, ten sam Redis): pozycja koszyka dodana na jednym
      podzie natychmiast widoczna/laczona na drugim; `disable('cart')`
      natychmiast gatuje `/cart` i `/api/cart` na OBU podach jednoczesnie -
      patrz "Wspoldzielony stan (Redis)" wyzej
- [x] `host: 0.0.0.0` w `cordis.yml` - proces nasluchuje na wszystkich
      interfejsach (`*:8080`, zweryfikowane przez `lsof`), nie tylko na
      loopback (patrz ARCHITECTURE.md#pivot-fixes - wczesniej brakujace,
      lamalo kazdy deployment Docker/Kubernetes)
- [ ] `deploy/k8s/` + `deploy/workflows/build-and-push.yml` - manifesty i pipeline
      napisane wedlug udokumentowanego, poprawnego API (`kubectl`/`kustomize`/GHCR),
      ale NIE uruchomione end-to-end na prawdziwym klastrze/rejestrze w tej sesji
      (brak dostepnych danych uwierzytelniajacych) - patrz `deploy/README.md#kubernetes`
      po instrukcje weryfikacji przed uzyciem produkcyjnym

Usunieto (celowo, ze wzgledow bezpieczenstwa): wczesniejszy mechanizm
`@shop/remote-sync` + Cloudflare R2/KV, ktory dynamicznie pobieral i
rozpakowywal archiwa `.tar.gz` z kodem modulow w dzialajacym procesie, bez
weryfikacji integralnosci, sandboxa czy autoryzacji poza dostepem do `main`.
Uzasadnienie i pelny opis ryzyka: [`ARCHITECTURE.md#8`](./ARCHITECTURE.md).

Usunieto rowniez (przy przejsciu na jedna appke Nuxt, patrz
[`ARCHITECTURE.md#10`](./ARCHITECTURE.md)): `@shop/broker` (Service Broker -
HTTP reverse proxy po prefiksie sciezki) i `@shop/router-service` (reaktywna
tabela tras miedzy instancjami) - Nuxt sam routuje wewnatrz jednej appki, wiec
nie ma juz czego proxowac.

Czwarty modul (`modules/checkout`) jest celowo tylko zaplanowany, nie zbudowany -
patrz [`deploy/checkout-module-plan.md`](./deploy/checkout-module-plan.md).
