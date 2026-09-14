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

services/cart-service         koefekt 'cart'    - stan koszyka w pamieci procesu
services/product-service       koefekt 'product' - katalog produktow
services/feature-registry-service koefekt 'features' - ktore moduly sa aktualnie wlaczone

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
- Do deploymentu (nie do lokalnego dev): Docker, oraz `kubectl`/`kustomize`
  jesli wdrazasz na Kubernetesie - patrz `deploy/README.md#kubernetes`

## Szybki start (lokalnie)

```sh
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

Podmiana jest "make-before-break" (Section 6.2 papieru Cordis: Service
Broker), NIE dispose-then-create: `@shop/nuxt-wrapper` uruchamia nowa
instancje na porcie efemerycznym OBOK jeszcze dzialajacej starej, i DOPIERO
POTEM zamyka stara (`server.close()` odsacza polaczenia w locie, nie zrywa
ich) - appka sama siebie wymienia bez wlasnego przestoju. Stan uslug
backendowych (`CartService`, `ProductService`, `FeatureRegistryService` -
osobne fibery) przetrwa w calosci niezaleznie od podmiany appki.

## Skladanie/wylaczanie funkcjonalnosci bez rebuildu

Poza build-time (Nuxt Modules, wyzej), istnieje DRUGI, celowo odrebny
mechanizm: `services/feature-registry-service` (koefekt `features`) pamieta,
ktore z juz-zbudowanych modulow sa aktualnie wlaczone. To pozwala wgrac nowy
modul jako WYLACZONY (bezpieczny, zrewiewowany build), a potem wlaczyc go bez
rebuildu i bez restartu - `ctx.get('features').enable('checkout')` z
dowolnego miejsca majacego dostep do `ctx`. Zweryfikowane empirycznie w tej
sesji: `disable('cart')` -> `GET /cart` natychmiast `404`, `GET /product` i
`GET /` nadal `200`, zero rebuildu, zero restartu procesu. Pelny przyklad:
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
- [x] koefekt `features` (rejestr modulow): `disable('cart')` -> `GET /cart`
      natychmiast `404` (`GET /product`/`GET /`nadal `200`), bez rebuildu i
      bez restartu procesu - zweryfikowane przez sygnal procesu w sesji
      deweloperskiej (nie czesc commitowanego kodu, patrz
      `deploy/checkout-module-plan.md#7`)
- [x] hot-reload calej appki "make-before-break", bez przestoju (dev-only
      mechanizm - `cordis.dev.yml`, patrz sekcja wyzej)
- [x] graceful shutdown (SIGTERM) - kaskadowe zamkniecie w kolejnosci LIFO
- [x] `docker build` + `docker run` + `docker stop` calego systemu
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
