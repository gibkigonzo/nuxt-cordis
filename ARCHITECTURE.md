# Architektura

Ten dokument opisuje decyzje projektowe stojace za implementacja w tym repo i
jak mapuja sie na realne API pakietu `cordis@4.0.0-rc.8` (nie tylko na model
teoretyczny z papieru "A Programming Paradigm for Spatiotemporal Composability").
Kazda nietrywialna decyzja ponizej zostala faktycznie zweryfikowana przez
uruchomienie kodu w tym repo (patrz `README.md#status-weryfikacji`).

## 1. Nuxt Wrapper: dlaczego "jeden zbudowany plik JS"

Zamiast programowo sterowac `@nuxt/kit`'s `loadNuxt`/`buildNuxt` w runtime
(co wciagaloby nas w wewnetrzny, niestabilny mechanizm dev-serwera Nuxta -
Vite middleware, wlasny watcher, wlasny websocket HMR - konkurujacy z HMR
Cordisa), `@shop/nuxt-wrapper` zaklada, ze **build jest osobnym, wczesniejszym
krokiem** (`nuxi build`, w CI lub lokalnie), a wrapper jedynie **importuje
JEDEN zbudowany plik**.

Nitro (silnik serwera Nuxta) ma preset **`node-listener`**
(`nitro.preset = 'node-listener'` w `nuxt.config.ts`), zweryfikowany w zrodlach
`nitropack`: w przeciwienstwie do domyslnego presetu `node-server` (ktory sam
otwiera `http.Server` i nasluchuje na `process.env.PORT` przy imporcie - zle
dla wielu instancji w jednym procesie), `node-listener` **nie robi nic przy
imporcie** poza wyeksportowaniem golej funkcji:

```js
// .output/server/index.mjs (preset node-listener)
export { v as handler, x as listener, y as websocket } from './chunks/nitro/nitro.mjs'
```

`listener` to zwykly handler `(req, res) => void`, kompatybilny wprost z
`http.createServer(listener)`. Wrapper importuje ten plik i **sam** tworzy i
zamyka `http.Server` - to nasz jedyny punkt integracji z Nitro, zaden inny
wewnetrzny mechanizm nie jest dotykany.

```ts
// packages/nuxt-wrapper/src/index.ts (uproszczone)
const mod = await import(specifier)          // ?cordis=<id>&t=<timestamp>
const server = createServer(mod.listener)
await new Promise((resolve, reject) => server.listen(port, host, resolve))
// dispose:
await new Promise((resolve) => server.close(resolve))
```

Zalety tego podejscia (potwierdzone empirycznie):
- Zero zaleznosci od wewnetrznych/niestabilnych API `@nuxt/kit`.
- Artefakt to zawsze ten sam ksztalt katalogu (`<dir>/.output/server/index.mjs`)
  niezaleznie od tego, ktora aplikacja go produkuje - `cordis.yml` wskazuje
  na katalog na dysku (`apps/<id>`), zapieczony w obrazie na etapie builda
  (patrz `deploy/docker/Dockerfile`), NIE pobierany przez siec w runtime
  (patrz sekcja 8 nizej po uzasadnienie, dlaczego wczesniejszy model
  dynamicznego pobierania kodu zostal usuniety).

## 2. Bridge: jak Nuxt (osobny bundle) dociera do zywego `ctx`

Kazda zbudowana aplikacja Nuxt jest WLASNYM, odrebnym grafem modulow (Nitro/
Rollup bundluje wszystkie jej zaleznosci w jeden plik) - nie moze wiec
bezposrednio zaimportowac obiektu `ctx`, ktory zyje w module orchestratora,
mimo ze oba dzialaja w TYM SAMYM procesie Node.

Rozwiazanie (`packages/shared/src/bridge.ts`): globalny rejestr trzymany pod
kluczem z globalnego rejestru symboli (`Symbol.for(...)`, wiec dziala
niezaleznie od tego, przez ktora fizyczna kopie pakietu zostal zaimportowany),
zasilany PRZED wywolaniem `import()`:

```ts
setBridge(config.id, ctx)                          // nuxt-wrapper, tuz przed importem
const mod = await import(toBridgedSpecifier(entryHref, config.id))
```

Zbudowana aplikacja odczytuje kontekst wolajac `getCordisContext(import.meta.url)`
w dowolnym pliku `server/api/*.ts`. Kluczowa wlasciwosc: identyfikator jest
**zakodowany w samym specyfikatorze importu** (`?cordis=<id>&t=<timestamp>`),
NIE w zmiennej srodowiskowej - to eliminuje race condition przy rownoleglym
ladowaniu wielu instancji (dwa rownolegle `import()` z osobnymi zapytaniami
nigdy sie nie mieszaja, w przeciwienstwie do wspoldzielonego `process.env`).

Query string pelni tez role **cache-bustera dla HMR**: Node'owy loader ESM
cache'uje moduly po dokladnym URL, wiec kazdy reload potrzebuje NOWEGO
specyfikatora (`t=Date.now()`), inaczej Cordis zobaczylby stary, juz
zaimportowany kod. Dzieki temu, ze Rollup bundluje caly kod aplikacji w JEDEN
plik, `import.meta.url` odczytany z DOWOLNEGO miejsca w tym bundlu (plugin
Nitro, handler API) jest identyczny - rowny specyfikatorowi, ktorym wrapper
wywolal `import()`.

## 3. Serwisy jako oddzielne komponenty (nie czesc aplikacji "cart")

W przeciwienstwie do dosc naturalnej pierwszej interpretacji `PlAn.md` ("Cart
Service bedzie... w koszyku"), `CartService`/`ProductService` sa **wlasnymi,
niezaleznymi komponentami Cordis** (`packages/cart-service`,
`packages/product-service`), a nie czescia cyklu zycia aplikacji `apps/cart`.
`apps/cart` (UI) jest ROWNIEZ tylko konsumentem koefektu `cart`, dokladnie tak
jak `apps/product`.

Dlaczego: to czysciej odwzorowuje separacje "co dostarcza dana" od "co ja
renderuje" (Section 6.2 papieru: providers vs consumers jako odrebne
komponenty), i pozwala WSZYSTKIM czterem (docelowo) aplikacjom Nuxt korzystac
z JEDNEGO, generycznego `@shop/nuxt-wrapper` - zaden z nich nie potrzebuje
specjalnej logiki "jestem dostawca". Rownanie: serwis przetrwa hot-reload
kazdej z aplikacji UI (sa to niezalezne fibery) - zweryfikowane empirycznie
(stan koszyka przetrwal restart `product`).

## 4. Router jako reaktywny koefekt (nie hardkodowana tabela w brokerze)

`packages/router-service` to trzeci koefekt (`router`): mapa prefiks -> `{host,
port}`. Kazda instancja Nuxt (przez `@shop/nuxt-wrapper`, `config.route`)
**sama** rejestruje/wyrejestrowuje swoja trase przy aktywacji/dezaktywacji
fibera. Broker (`packages/broker`) nigdy nie zna z gory listy modulow - po
prostu przy kazdym zadaniu odpytuje `ctx.router.resolve(pathname)`.

To bezposrednio realizuje kluczowe zdanie z `deploy.md`: dodanie modulu nie
wymaga zadnej rekonfiguracji brokera - `RouterService` jest reaktywnym
koefektem, wiec broker "widzi" nowa trase natychmiast po tym, jak nowy fiber
osiagnie stan `ACTIVE`.

### `app.baseURL` i dlaczego broker NIE odcina prefiksu

Pierwotna (bledna) implementacja odcinala prefiks (`/product/api/x` ->
`/api/x`) przed przekazaniem requestu do instancji. To okazalo sie bledne
empirycznie: Nitro, majac skonfigurowane `app.baseURL: '/product/'`, sam
przekierowuje (302) kazdy request NIE zaczynajacy sie od tego prefiksu z
powrotem na prefiksowana sciezke - petla przekierowan. Poprawne rozwiazanie:
kazda aplikacja zna wlasny prefiks przez `app.baseURL` (uzywany tez do
generowania linkow/assetow po stronie klienta), a broker przekazuje sciezke
BEZ ZMIAN - Nitro sam dopasowuje trasy wzgledem skonfigurowanego baseURL.

## 5. Dwa niezalezne mechanizmy hot-reloadu

- **`@cordisjs/plugin-hmr`** (entry `hmr` w `cordis.dev.yml`) obserwuje
  *zrodla* komponentow warstwy Cordis (`packages/*/src`, statyczny graf
  importow). Dziala dobrze dla `cart-service`/`nuxt-wrapper`/`broker` - sa
  importowane przez staly, bare specyfikator (`@shop/cart-service`).
- **Wlasny watcher w `@shop/nuxt-wrapper`** (`config.watch: true`) obserwuje
  zbudowany plik KONKRETNEJ aplikacji Nuxt i wola natywne `ctx.fiber.restart()`.
  Powod odrebnego mechanizmu: kazda aplikacja Nuxt jest ladowana przez
  **dynamiczny** `import()` z URL-em obliczanym w runtime (patrz punkt 2) -
  `@cordisjs/plugin-hmr` sledzi STATYCZNY graf modulow, wiec nigdy nie
  zobaczylby tego importu jako czesci grafu zaleznosci komponentu.

Zweryfikowane: rebuild `apps/product` w tle -> log `wykryto nowy build,
restartuje fiber` -> stary serwer zamkniety, trasa wyrejestrowana, nowy
zbudowany kod zaimportowany i wystawiony na tym samym porcie - podczas gdy
rownolegle odpytywany `apps/cart` (60 zapytan co 100ms) zwracal wylacznie `200`.

## 6. TypeScript bez kroku budowania {#typescript}

Caly kod warstwy Cordis (`packages/*`, `orchestrator/`) to **prawdziwy
TypeScript** uruchamiany bezposrednio przez `node plik.ts`, korzystajac z
natywnego "type stripping" Node (stabilne w Node 24+, dostepne za flaga
`--experimental-strip-types` / domyslnie wlaczone od Node 22.6+/23.6+). Zero
`tsc`/`tsx`/`esbuild` w petli developerskiej tej warstwy.

Ograniczenia (celowo respektowane w calym kodzie, wymuszone flaga
`erasableSyntaxOnly: true` w `tsconfig.base.json`):
- brak `enum` (uzywamy string-literal unions / `as const`),
- brak parameter properties w konstruktorach (`constructor(private x: T)`) -
  pola sa deklarowane jawnie i przypisywane w ciele konstruktora,
- importy wzgledne wymagaja jawnego rozszerzenia `.ts`.

Aplikacje Nuxt (`apps/*`) NIE maja tego ograniczenia - Vite/esbuild wewnatrz
Nuxta obsluguje pelny TypeScript bez zadnych wyjatkow.

## 7. Izolacja realmow (`ctx.isolate`) - udokumentowana, nie wymuszona

Prawdziwe API (`ctx.isolate(name, label?)`) zostalo zweryfikowane w
zrodlach `cordis`/`@cordisjs/plugin-loader` (mechanizm `LocalRealm`/`GlobalRealm`
z `entry.options.isolate`). W tym repo **zaden z trzech koefektow nie
wymaga izolacji** - `cart`/`product`/`router` sa CELOWO wspoldzielone (to caly
sens architektury). Gdyby ktoras z instancji Nuxt potrzebowala WLASNEJ,
nie-wspoldzielonej konfiguracji pod tym samym kluczem (np. `theme` per-apka),
`@shop/nuxt-wrapper` mozna rozszerzyc o `config.isolate: string[]`, wolajac
`ctx2.isolate(key)` przed pozostalymi operacjami koefektowymi - identycznie
jak juz robimy z `route`/`inject`. Swiadomie NIE dodano tego jako
niewykorzystywanej funkcji "na zapas" (zasada z instrukcji: nie budowac
niepotrzebnych abstrakcji) - jest to udokumentowane rozszerzenie, nie
zaimplementowana-ale-martwa funkcjonalnosc.

## 8. Dlaczego usunieto dynamiczne pobieranie kodu przez siec (i co jest zamiast) {#dynamic-code-loading}

Wczesniejsza wersja tego repo (`docs/deploy.md`, historyczny plan) realizowala
model, w ktorym `@shop/remote-sync` okresowo odpytywal zdalny manifest
(Cloudflare KV przez maly Worker, `deploy/cloudflare/manifest-worker`),
pobieral zmienione moduly jako archiwa `.tar.gz` z Cloudflare R2 i wolal
`ctx.loader.create/update/remove` na dzialajacym procesie - bez restartu.
Mechanizm dzialal (zweryfikowany lokalnie z mockiem,
`deploy/scripts/mock-registry-server.mjs`), ale analiza bezpieczenstwa tego
podejscia wykazala fundamentalne problemy, przez ktore zostal **calkowicie
usuniety** (nie: wylaczony/opcjonalny - usuniety z kodu):

- **Brak weryfikacji integralnosci.** `fetch()` na manifest i artefakt bez
  checksumy, podpisu (sigstore/minisign) czy pinningu do konkretnego
  commit-SHA. Pole `version` bylo tylko trigger'em reload'u, nie
  weryfikowanym hashem tresci.
- **Brak sandboxa przy rozpakowaniu.** `tar -xzf` bezposrednio na dysk hosta
  procesu produkcyjnego - zero whitelisty sciezek, zero ochrony przed
  zip-slip/decompression bomb.
- **Zaimportowany kod dostawal pelne uprawnienia procesu.** Zwykly
  `import()` w TYM SAMYM procesie co orchestrator, z dostepem przez
  `packages/shared/src/bridge.ts` do zywego `Context` cordis - czyli do
  wszystkich koefektow (`cart`, `product`, `router`), `process.env` i FS.
  Brak izolacji (`ctx.isolate` pozostaje nieuzywane, patrz sekcja 7).
- **Jedyna "autoryzacja" to dostep do `main`/sekretow CI.** Sam manifest i
  endpoint artefaktu byly publicznymi GET-ami bez tokenow - kazdy z prawem
  merge'a do `main` mogl wstrzyknac dowolny kod do produkcyjnego procesu w
  ciagu jednego cyklu pollingu (domyslnie 15s).
- **All-or-nothing hot-swap.** Zero canary/staged rollout, zero automatycznego
  rollbacku przy bledzie ladowania - blad byl tylko logowany
  (`ctx.logger.warn`), a kolejny poll probowal ponownie.

**Model zastepczy (aktualny, patrz `deploy/README.md#kubernetes`):**
dystrybucja kodu i orkiestracja runtime sa teraz jawnie rozdzielone.
`deploy/workflows/build-and-push.yml` buduje CALY system w jeden niezmienny
obraz OCI (git sha jako tag) i publikuje go do rejestru (GHCR) - standardowy
lancuch zaufania CI/rejestr, bez wlasnego protokolu dystrybucji. Kubernetes
(`deploy/k8s/`) wykonuje deployment: `RollingUpdate` z `maxUnavailable: 0`
(zero przestoju przy aktualizacji, analogicznie do wczesniejszego celu
"bez restartu", ale przez mechanizm, ktory k8s juz gwarantuje i testuje),
readiness/liveness probes, oraz standardowy `kubectl rollout undo` jako
rollback. **Cordis w tym modelu jest WYLACZNIE orchestratorem kodu juz
zapieczonego w obrazie** - `cordis.yml` jest czytany raz przy starcie
procesu (`orchestrator/src/index.ts`), zero reconcilera zdalnej
konfiguracji, zero `fetch()`/`import()` z URL-a obliczanego w runtime poza
lokalnymi plikami w obrazie. Dodanie nowego modulu (patrz
`deploy/checkout-module-plan.md`) to teraz: zmiana kodu -> `cordis.yml` ->
normalny `git push` -> CI buduje nowy obraz -> rolling update - bez zadnej
sciezki, w ktorej kod trafia do produkcyjnego procesu bez przejscia przez
review + CI.

Kompromis: utracono zdolnosc do aktualizacji POJEDYNCZEGO modulu bez
rebuildu calego obrazu (kazda zmiana buduje wszystkie trzy aplikacje na
nowo). W zamian za to nie ma juz drugiego, rownoleglego kanalu wprowadzania
kodu do procesu produkcyjnego omijajacego standardowy pipeline CI/CD.

**Czy to jest sprzeczne z papierem (`docs/paper.md`)?** Papier krytykuje
restart procesu + orkiestracje kontenerowa jako "coarse-grained workaround"
dla braku fine-grained composability (Section 1.2.3, `docs/paper.md:128-136`):
restart kasuje stan procesu i wymaga nadmiarowych replik na czas
niedostepnosci, a granica kontenera nie wyraza zaleznosci miedzy komponentami
dzielacymi jeden adres pamieci, wprowadzajac zbedny narzut sieciowy. Sekcja
6.2 (`docs/paper.md:1939`) idzie dalej: proponuje, zeby rolling update
byl wzorcem NA POZIOMIE APLIKACJI (nowy fiber + broker + stopniowe
przesuniecie ruchu), a nie operacja infrastrukturalna ("container
orchestration, blue-green deployment").

To NIE oznacza "unikaj Kubernetesa w ogole" - oznacza "nie uzywaj granicy
kontenera tam, gdzie komponenty dziela adres pamieci i powinny byc
skladane w procesie". Ten repo juz stosuje wlasnie to rozroznienie:
`home`/`product`/`cart` NIE sa trzema Deploymentami wolajacymi sie przez
siec - sa fiberami JEDNEGO procesu (dokladnie fine-grained composability
z papieru), a Kubernetes ponizej odpowiada WYLACZNIE za to, czego Cordis
nie adresuje w ogole i czego papier mu nie zarzuca: rozmieszczenie replik
CALEGO procesu na wielu maszynach, przetrwanie awarii wezla, `Service`
jako stabilny punkt wejscia dla load balancera. Papier nie ma tu
konkurencyjnej propozycji - Section 6.2's "cross-process invocation"
zaklada, ze wiele procesow juz gdzies fizycznie dziala, nie mowi jak je
tam umiescic.

Prawdziwy, uczciwie przyznany kompromis jest wezszy: utracono zdolnosc
zaktualizowania JEDNEGO modulu bez rolling restartu CALEGO procesu na
wszystkich replikach - dokladnie ta zdolnosc, ktora Section 6.2 opisuje
jako wzorzec aplikacyjny i ktora `@shop/remote-sync` probowal
zaimplementowac. Usunieto go nie dlatego, ze pomysl "aktualizuj fiber bez
restartu calego procesu" byl bledny (jest dokladnie tym, co zaleca papier),
tylko dlatego, ze KONKRETNA implementacja (niepodpisany `fetch()` + `tar`
+ `import()` z pelnym zaufaniem procesu) byla niezweryfikowalna. Wzorzec z
papieru (nowy provider ACTIVE -> przelaczenie ruchu -> dispose starego) jest
teraz FAKTYCZNIE zaimplementowany lokalnie: `@shop/nuxt-wrapper` (`config.watch`,
uzywane w `cordis.dev.yml`) robi make-before-break, nie dispose-then-create -
nowa instancja wstaje na porcie efemerycznym OBOK starej, `RouterService`
przelacza sie na nia dopiero gdy nasluchuje, stara jest zamykana DOPIERO
POTEM (`server.close()` odsacza polaczenia w locie). Zweryfikowane
empirycznie: 260 zapytan co 50ms do `/product` obejmujacych caly rebuild -
`0/260` bledow (patrz `README.md#status-weryfikacji`). Odtworzenie tego
bezpiecznie w produkcji (nie tylko dev) wymagaloby podpisanych/weryfikowanych
artefaktow per-modul (np. `cosign verify` na tym samym mechanizmie atestacji
SLSA, ktory `deploy/workflows/build-and-push.yml` juz generuje dla calego
obrazu) plus loadera Cordis konsumujacego WYLACZNIE zweryfikowane pliki
lokalne - to osobny, wiekszy projekt, celowo NIE podjety bez wyraznej
prosby, bo nietrywialnie poszerza zakres.

## 9. Graceful shutdown

`orchestrator/src/index.ts` lapie `SIGINT`/`SIGTERM` i woła `ctx.fiber.dispose()`
na fiberze glownego kontekstu - kaskadowo cofa efekty calego drzewa komponentow
w kolejnosci LIFO (Theorem 16/66 papieru: recovery exactness + gwarantowane
osiagniecie stanu spoczynkowego). Zweryfikowane: `docker stop` zamyka caly
system (3 serwery HTTP + wyrejestrowanie tras) w ~160ms, bez wymuszonego
`SIGKILL`.
