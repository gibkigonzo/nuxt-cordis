# nuxt-cordis-shop

Sklep zbudowany jako **modularny monolit runtime**: trzy (docelowo wiecej)
niezalezne aplikacje Nuxt, kazda budowana i wersjonowana osobno, dzialaja jako
**fibery jednego procesu Node** orkiestrowanego przez [Cordis](https://github.com/cordiverse/cordis)
— meta-framework spatiotemporal composability (rewersyjne efekty + reaktywne
koefekty). Zero kontenerow-na-uslugę, zero sieci miedzy modulami dzielacymi
stan, pelna izolacja bledow i hot-reload pojedynczej aplikacji bez przerywania
pozostalych.

Zbudowane w oparciu o [`docs/PlAn.md`](./docs/PlAn.md) (architektura). Wczesniejszy
plan deploymentu z [`docs/deploy.md`](./docs/deploy.md) (dynamiczne pobieranie
kodu modulow przez siec w dzialajacym procesie) zostal **swiadomie porzucony
ze wzgledow bezpieczenstwa** - patrz [`ARCHITECTURE.md#8`](./ARCHITECTURE.md)
po uzasadnienie. Zobacz [`ARCHITECTURE.md`](./ARCHITECTURE.md) po pelny opis
decyzji projektowych i [`deploy/README.md`](./deploy/README.md) po przewodnik
wdrozenia (Docker do testow lokalnych, Kubernetes jako sciezka produkcyjna).

## Struktura

```text
apps/home            Nuxt - strona glowna           (port 3000, /)
apps/product          Nuxt - katalog produktow        (port 3001, /product)
apps/cart              Nuxt - koszyk                    (port 3002, /cart)

services/cart-service   koefekt 'cart'    - stan koszyka w pamieci procesu
services/product-service koefekt 'product' - katalog produktow
services/router-service koefekt 'router'  - reaktywna tabela tras dla brokera

packages/nuxt-wrapper   Cordis-owy wrapper: start/stop zbudowanej apki Nuxt
packages/broker         Service Broker (brama HTTP, jeden publiczny port)
packages/shared         wspoldzielone typy + "bridge" (patrz ARCHITECTURE.md)

orchestrator            bootstrapuje Context + Loader; caly skladu opisuje cordis.yml
cordis.yml               deklaratywna konfiguracja calego systemu (zrodlo prawdy)
deploy/                  Docker, manifesty Kubernetes, pipeline CI (GitHub Actions)
```

Rozroznienie `packages/` vs `services/` jest mechaniczne, nie "biznes vs infra":
`services/*` to komponenty Cordisa, ktore `provide`-uja koefekt WSTRZYKIWANY
przez cos innego (`cart-service`/`product-service`/`router-service` - wszystkie
trzy sa `inject`-owane gdzie indziej, mimo ze `router-service` jest infrastruktura
routingu, nie logika domenowa). `packages/*` to reszta: albo zwykle biblioteki
bez cyklu zycia Cordisa (`shared`), albo komponenty Cordisa, ktore SAME
konsumuja koefekty, ale niczego nie dostarczaja innym (`broker`, `nuxt-wrapper` -
nic ich nie `inject`-uje).

## Wymagania

- Node.js **24+** (dziala tez na 22.6+ dzieki natywnemu "type stripping", ale
  22 wypisuje eksperymentalne ostrzezenia - patrz `ARCHITECTURE.md#typescript`)
- pnpm 9 (`corepack enable` jesli nie masz)
- Do deploymentu (nie do lokalnego dev): Docker, oraz `kubectl`/`kustomize`
  jesli wdrazasz na Kubernetesie - patrz `deploy/README.md#kubernetes`

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
`cordis.dev.yml`) obserwujacy katalog aplikacji. W drugim terminalu:

```sh
pnpm --filter product run build   # zmien kod, przebuduj
```

Podmiana jest "make-before-break" (Section 6.2 papieru Cordis: Service
Broker), NIE dispose-then-create: `@shop/nuxt-wrapper` uruchamia nowa
instancje na porcie efemerycznym OBOK jeszcze dzialajacej starej, przelacza
`RouterService` na nia dopiero gdy nowa faktycznie nasluchuje, i DOPIERO
POTEM zamyka stara (`server.close()` odsacza polaczenia w locie, nie zrywa
ich) - `product` sam siebie wymienia bez wlasnego przestoju, nie tylko bez
wplywu na `home`/`cart`. Zweryfikowane empirycznie w tej sesji: 260 zapytan
co 50ms do `/product` w petli obejmujacej caly rebuild - `0/260` bledow,
`curl /cart` i `curl /` rowniez caly czas `200`. Stan `CartService` (osobny
fiber) przetrwa w calosci niezaleznie.

## Deployment

Jedna sciezka: **buduj jeden niezmienny obraz Docker w CI, wdrazaj rolling
update'em w Kubernetesie.** Cordis pozostaje WYLACZNIE orchestratorem kodu
juz zapieczonego w obrazie - `cordis.yml` jest czytany raz przy starcie,
zero pobierania kodu przez siec w dzialajacym procesie.

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

- [x] build + start 3 aplikacji, routing przez brokera, wspoldzielony stan koszyka
- [x] hot-reload pojedynczej aplikacji "make-before-break", bez przestoju SAMEJ
      SIEBIE ani pozostalych (0/260 bledow w teście obejmujacym caly rebuild,
      dev-only mechanizm - `cordis.dev.yml`, patrz sekcja wyzej - nie myl z usunietym
      mechanizmem dystrybucji kodu przez siec opisanym w `ARCHITECTURE.md#8`)
- [x] graceful shutdown (SIGTERM) - kaskadowe zamkniecie w kolejnosci LIFO
- [x] izolacja bledow: awaria jednej instancji nie wplywa na pozostale
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

Czwarty modul (`apps/checkout`) jest celowo tylko zaplanowany, nie zbudowany -
patrz [`deploy/checkout-module-plan.md`](./deploy/checkout-module-plan.md).
