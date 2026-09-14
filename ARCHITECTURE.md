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
plik, `import.meta.url` odczytany z DOWOLNEGO miejsca w tym bundlu (handler
API, middleware) jest identyczny - rowny specyfikatorowi, ktorym wrapper
wywolal `import()`.

### Wyjatek: `server/plugins/*` widza `import.meta.url` NIEPOPRAWNIE {#plugin-import-meta-gotcha}

Powyzsza gwarancja ("`import.meta.url` jest identyczny gdziekolwiek w bundlu")
**nie dziala** wewnatrz plikow `server/plugins/*.ts` - odkryte empirycznie w
tej sesji przy pierwszej probie zasilenia `services/feature-registry-service`
z Nitro pluginu. Przyczyna: `.output/server/index.mjs` (preset `node-listener`)
zawiera dwie linie:

```js
globalThis._importMeta_ = { url: import.meta.url, env: process.env }
export { v as handler, x as listener, y as websocket } from './chunks/nitro/nitro.mjs'
```

Nitro **przepisuje** kazde uzycie `import.meta.url` w zbundlowanym kodzie
uzytkownika na `globalThis._importMeta_.url` (kompatybilnosc z presetami, w
ktorych natywny `import.meta.url` nie jest dostepny/stabilny). Ale wedlug
specyfikacji ES modules, zaleznosci (`export ... from './chunks/nitro/nitro.mjs'`)
sa **linkowane i ewaluowane PRZED** wykonaniem reszty kodu modulu importujacego
- `chunks/nitro/nitro.mjs` (ktory wola `runNitroPlugins()` NA SWOIM WLASNYM
poziomie top-level, SYNCHRONICZNIE, podczas ewaluacji) uruchamia sie WCZESNIEJ
niz linijka `globalThis._importMeta_ = {...}` w `index.mjs` w ogole wykona.
Kazdy plugin, ktory czyta `import.meta.url` (czyli u nas: `globalThis._importMeta_.url`)
podczas wlasnej rejestracji, widzi wiec `undefined` - `getCordisContext()`
rzuca `"brak id w URL"`, mimo ze `setBridge(config.id, ctx2)` w
`@shop/nuxt-wrapper` juz zdazyl wpisac kontekst do rejestru PRZED wywolaniem
`import()`.

`server/api/*.ts` i `server/middleware/*.ts` NIE maja tego problemu: ich
handlery wykonuja sie leniwie, PER REQUEST, dlugo po tym jak caly graf
modulow (w tym `globalThis._importMeta_ = {...}`) juz w pelni sie zewaluowal.
**Regula:** jesli kod potrzebuje `getCordisContext(import.meta.url)`, MUSI
zyc w handlerze wywolywanym per-request (`server/api/*`, `server/middleware/*`),
NIGDY w ciele `defineNitroPlugin(...)` wykonywanym eagerly przy imporcie -
patrz `apps/shop/server/middleware/feature-gate.ts` (rejestruje manifest
leniwie, przy pierwszym requescie, zamiast w usunietym `server/plugins/cordis.ts`).

## 3. Serwisy jako oddzielne komponenty (nie czesc modulu "cart")

W przeciwienstwie do dosc naturalnej pierwszej interpretacji `PlAn.md` ("Cart
Service bedzie... w koszyku"), `CartService`/`ProductService` sa **wlasnymi,
niezaleznymi komponentami Cordis** (`services/cart-service`,
`services/product-service`), a nie czescia cyklu zycia modulu `modules/cart`.
`modules/cart` (UI) jest ROWNIEZ tylko konsumentem koefektu `cart`, dokladnie
tak jak `modules/product`.

Dlaczego: to czysciej odwzorowuje separacje "co dostarcza dana" od "co ja
renderuje" (Section 6.2 papieru: providers vs consumers jako odrebne
komponenty). Ta separacja przetrwala pivot na jedna aplikacje Nuxt
(ARCHITECTURE.md#10) w niezmienionej formie: uslugi backendowe sa nadal
WLASNYMI fiberami Cordis, niezaleznymi od tego, ile modulow Nuxta jest
skomponowanych w `apps/shop` ani jak czesto ta jedna appka jest przebudowywana
- serwis przetrwa kazdy jej hot-reload (osobny fiber) - zweryfikowane
empirycznie (stan koszyka przetrwal restart `apps/shop`).

## 4. Feature registry jako reaktywny koefekt (nie broker + tabela tras) {#feature-registry}

**Historia (zobacz `git log` po pelna wersje sprzed pivotu):** ta sekcja
opisywala `services/router-service` (koefekt `router`: mapa prefiks ->
`{host, port}`) + `packages/broker` (HTTP reverse proxy odpytujacy te mape
przy kazdym requescie), potrzebne, gdy sklep skladal sie z TRZECH osobnych
aplikacji Nuxt na trzech portach. Oba zostaly **usuniete** przy pivocie na
JEDNA aplikacje Nuxt (`apps/shop`, ARCHITECTURE.md#10) - Nuxt sam routuje
wewnatrz jednej appki (kazdy modul rejestruje wlasna strone przez
`nuxt.hook('pages:extend', ...)`, patrz `modules/*/src/module.ts`), wiec nie
ma juz osobnych portow do proxowania ani czego HTTP-owo przekierowywac.
Rowniez gotcha "broker NIE odcina prefiksu `app.baseURL`" (CLAUDE.md,
wczesniejsza wersja) przestala dotyczyc tego repo z tego samego powodu.

**To, co zastapilo router jako "reaktywny koefekt reprezentujacy dostepnosc
modulow"**, to `services/feature-registry-service` (koefekt `features`) -
patrz `ARCHITECTURE.md#10` po pelny opis warstwy. W skrocie: zamiast mapy
`prefiks -> {host, port}` (routing miedzy PROCESAMI), trzyma mape
`id modulu -> {routes, enabled}` (WIDOCZNOSC kodu w ramach JEDNEGO procesu).
`apps/shop/server/middleware/feature-gate.ts` odpytuje ja przy kazdym
requescie (`features.resolve(pathname)` + `features.isEnabled(id)`) i zwraca
`404`, jesli modul odpowiedzialny za dana sciezke jest wylaczony - bez zadnego
proxowania, bo caly kod juz dziala w tym samym procesie/porcie.

Zweryfikowane empirycznie w tej sesji: `ctx.get('features').disable('cart')`
(wywolane przez sygnal procesu w sesji deweloperskiej, patrz
`deploy/checkout-module-plan.md#7`) -> kolejny `GET /cart` natychmiast `404`,
`GET /product` i `GET /` nadal `200`, zero rebuildu, zero restartu -
identyczna gwarancja "widocznosc natychmiast po zmianie stanu", jaka wczesniej
demonstrowal `RouterService`, tylko zastosowana do WLACZENIA/WYLACZENIA kodu
zamiast do jego LOKALIZACJI SIECIOWEJ.

## 5. Dwa niezalezne mechanizmy hot-reloadu

- **`@cordisjs/plugin-hmr`** (entry `hmr` w `cordis.dev.yml`) obserwuje
  *zrodla* komponentow warstwy Cordis (`packages/*/src`, `services/*/src`,
  statyczny graf importow). Dziala dobrze dla `cart-service`/`nuxt-wrapper` -
  sa importowane przez staly, bare specyfikator (`@shop/cart-service`).
  **NIE** obserwuje `modules/*` - te sa konsumowane WYLACZNIE przez build
  Nuxta (`nuxi build` w `apps/shop`), nie sa importowane bezposrednio przez
  zaden komponent Cordis.
- **Wlasny watcher w `@shop/nuxt-wrapper`** (`config.watch: true`) obserwuje
  zbudowany plik `apps/shop` i wola natywne `ctx.fiber.restart()`. Powod
  odrebnego mechanizmu: appka jest ladowana przez **dynamiczny** `import()` z
  URL-em obliczanym w runtime (patrz punkt 2) - `@cordisjs/plugin-hmr` sledzi
  STATYCZNY graf modulow, wiec nigdy nie zobaczylby tego importu jako czesci
  grafu zaleznosci komponentu. Ten watcher obserwuje CALY katalog `apps/shop`
  (w tym efekty zmian w `modules/*` - Rollup/Nitro bundluje ich kod
  bezposrednio do wynikowego `.output/server/index.mjs`, wiec zmiana w
  `modules/cart/src/module.ts` po `pnpm --filter shop run build` tworzy nowy
  build TEGO SAMEGO pliku, ktory ten watcher juz obserwuje).

Zweryfikowane (sprzed pivotu na jedna appke, mechanizm niezmieniony): rebuild
w tle -> log `wykryto nowy build, uruchamiam nowa instancje obok starej` ->
stary serwer zamkniety, nowy zbudowany kod zaimportowany i wystawiony na tym
samym porcie, zero przerwanych requestow w locie (make-before-break, patrz
`packages/nuxt-wrapper/src/index.ts`).

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
Nuxta obsluguje pelny TypeScript bez zadnych wyjatkow. `modules/*` (Nuxt
Modules) sa w tej samej kategorii co `apps/*`, nie co `packages/*`/`services/*`:
`defineNuxtModule(...)` jest ladowany przez WLASNY loader Nuxta (jiti) podczas
`nuxi build`/`nuxi dev` appki `apps/shop`, nie przez natywny Node type-stripping
- pelny TypeScript, zero ograniczen `erasableSyntaxOnly`.

## 7. Izolacja realmow (`ctx.isolate`) - udokumentowana, nie wymuszona

Prawdziwe API (`ctx.isolate(name, label?)`) zostalo zweryfikowane w
zrodlach `cordis`/`@cordisjs/plugin-loader` (mechanizm `LocalRealm`/`GlobalRealm`
z `entry.options.isolate`). W tym repo **zaden z trzech koefektow nie
wymaga izolacji** - `cart`/`product`/`features` sa CELOWO wspoldzielone (to
caly sens architektury), a jest tylko JEDNA instancja `@shop/nuxt-wrapper`
(`apps/shop`) do ktorej sa wstrzykiwane. Gdyby w przyszlosci powstala DRUGA
niezalezna aplikacja Nuxt (osobny fiber, patrz kompromis w ARCHITECTURE.md#10)
potrzebujaca WLASNEJ, nie-wspoldzielonej konfiguracji pod tym samym kluczem
(np. `theme`), `@shop/nuxt-wrapper` mozna rozszerzyc o `config.isolate: string[]`,
wolajac `ctx2.isolate(key)` przed pozostalymi operacjami koefektowymi -
identycznie jak juz robimy z `inject`. Swiadomie NIE dodano tego jako
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
skladane w procesie". Ten repo juz stosuje wlasnie to rozroznienie: uslugi
backendowe (`cart`/`product`/`features`) NIE sa osobnymi Deploymentami
wolajacymi sie przez siec - sa fiberami JEDNEGO procesu (dokladnie
fine-grained composability z papieru), a Kubernetes ponizej odpowiada
WYLACZNIE za to, czego Cordis
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
nowa instancja wstaje na porcie efemerycznym OBOK starej, ruch przelacza sie
na nia dopiero gdy nasluchuje, stara jest zamykana DOPIERO POTEM
(`server.close()` odsacza polaczenia w locie). Zweryfikowane empirycznie
(sprzed pivotu na jedna appke, mechanizm niezmieniony): 260 zapytan co 50ms
obejmujacych caly rebuild - `0/260` bledow (patrz `README.md#status-weryfikacji`).
Odtworzenie tego
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
system w ~160ms, bez wymuszonego `SIGKILL`.

## 10. Warstwy: gdzie w tym repo faktycznie zyje Cordis {#layers}

Ten dokument reaguje na zewnetrzna analize (rozmowa z AI, przygotowana przez
uzytkownika, wrzesien 2026) na pytanie "na jakich warstwach dalo by sie
zaimplementowac Cordis w Nuxcie, zeby nie bylo to zrobione naiwnie". Kluczowy
wniosek tamtej analizy: NIE budowac jednego globalnego kontenera Cordis
importowanego jednoczesnie przez build, Nitro, SSR i klienta, tylko rozdzielic
system na osobne warstwy o roznym czasie zycia:

```text
Nuxt module - build time              -> generuje statyczne manifesty
Nitro root context - lifetime procesu -> tworzy child scope
Request/SSR context - lifetime requestu -> serializuje tylko dane
Client context - lifetime aplikacji/feature -> UI slots / lazy islands
```

Uwaga terminologiczna: `cordis` uzywany w tym repo to pakiet
[`cordiverse/cordis`](https://github.com/cordiverse/cordis) (ten sam, ktory
opisuje `docs/paper.md`). Zewnetrzne analizy tego typu czasem mieszaja w
cytowaniach niepowiazane projekty o podobnie brzmiacych nazwach - warstwy
ponizej sa zweryfikowane wzgledem FAKTYCZNEGO kodu tego repo, nie
bezkrytycznie przepisane z zewnetrznego zrodla.

**Ten repo TERAZ JEST** dokladnie tym scenariuszem, ktory analiza opisuje
wprost - jedna aplikacja Nuxt (`apps/shop`) z wtyczalnymi "feature'ami"
(`modules/home`, `modules/product`, `modules/cart`, docelowo `modules/checkout`).
To wynik pivotu (patrz Sekcja 11) z wczesniejszego ksztaltu (TRZY osobne
aplikacje Nuxt + broker HTTP), ktory analiza posrednio skrytykowala: broker +
osobne porty duplikowaly mechanizm, ktory Nuxt juz ma wbudowany (routing
wewnatrz jednej appki). Warstwy ponizej sa wiec teraz bezposrednim,
literalnym odwzorowaniem, nie tylko "duchem" analizy:

1. **Build-time (manifest)** -> `modules/*/src/module.ts` - **doslownie**
   `defineNuxtModule` z `@nuxt/kit`, uruchamiane podczas `nuxi build`/`nuxi dev`
   appki `apps/shop` (Sekcja 6). To DOKLADNIE mechanizm z analizy ("Moduly
   Nuxta sa wlasnie mechanizmem build-time i moga generowac pluginy,
   komponenty, serwerowe handlery"), nie analogia do niego: kazdy modul
   rejestruje wlasna strone (`nuxt.hook('pages:extend', ...)`), wlasne server
   routes (`addServerHandler(...)`) i dopisuje siebie do
   `runtimeConfig.shopFeatures` - build-time manifest skladany z fragmentow
   dostarczanych przez kazdy modul z osobna, analogicznie do `clientLoaders`/
   `defineFeature()` z analizy (z ta roznica, ze manifest u nas idzie przez
   `runtimeConfig`, nie przez osobny wygenerowany plik `.ts` - prostszy
   mechanizm, wystarczajacy przy tej skali).
2. **Nitro root / uslugi o czasie zycia procesu** -> `orchestrator/src/index.ts`
   (korzenny `ctx`) + `services/cart-service`, `services/product-service`,
   `services/feature-registry-service`. Tworzone raz, zyja przez caly proces,
   sa JEDYNA rzecza wstrzykiwana do `apps/shop` (`config.inject` w
   `cordis.yml`). Zaden graf pluginow nie jest montowany od nowa przy kazdym
   requescie - dokladnie to, przed czym ostrzega analiza. **Gotcha odkryta w
   tej sesji:** `server/plugins/*` (rekomendowane w analizie jako miejsce na
   "root.plugin(featureRegistryPlugin)") NIE moze u nas czytac
   `getCordisContext(import.meta.url)` - patrz `#plugin-import-meta-gotcha`
   w Sekcji 2. Manifest jest wiec zasilany leniwie z middleware
   (`apps/shop/server/middleware/feature-gate.ts`), nie z pluginu Nitro -
   drobna, ale empirycznie wymuszona roznica wzgledem przykladu w analizie.
3. **Request scope** -> [`packages/shared/src/request-scope.ts`](./packages/shared/src/request-scope.ts)
   (`ensureCartId`). Celowo waska (jeden identyfikator koszyka z cookie) - ten
   demo-sklep nie ma autoryzacji/tenantow/tracingu, wiec dodawanie ich "na
   zapas" byloby dokladnie tym, czego zabrania CLAUDE.md ("nie projektuj pod
   hipotetyczne przyszle wymagania"). Gdyby sie pojawily, to jest miejsce,
   gdzie naturalnie rosna.
4. **SSR nuxtApp adapter / client kernel / UI slots / profile hydratacji** ->
   NADAL SWIADOMY BRAK, ale teraz z INNEGO powodu niz przed pivotem. Wczesniej
   argument brzmial "nie mamy jednej appki, wiec ten problem nas nie dotyczy" -
   to juz nieprawda (mamy jedna appke). Aktualny argument: granica modulu w
   tym repo to CALA STRONA (`/`, `/product`, `/cart`), nie fragment UI
   wewnatrz strony - a analiza WPROST ostrzega przed odwrotnoscia: "Zla
   granica bylby kazdy atom UI, przycisk czy karta - wtedy koszt abstrakcji i
   lifecycle'u szybko przewyzszy korzysci". Przy tej granulacji (cale strony,
   kazda z wlasnym `useFetch`/`$fetch` do wlasnego server route) NIE ma
   potrzeby na client-side kernel/registry slotow/strategie hydratacji per
   fragment - zwykly SSR + `<NuxtLink>` Nuxta juz to zalatwia. Zweryfikowane w
   kodzie: `bridge.ts` jest importowany WYLACZNIE z `server/api/*.ts`/
   `server/middleware/*.ts` przez jawna podsciezke `@shop/shared/bridge`,
   nigdy z pliku `.vue`; komponenty `.vue` importuja z `@shop/shared`
   wylacznie przez `import type` (Product/CartSnapshot), ktore TypeScript/Vite
   usuwaja calkowicie przed bundlowaniem - zaden kod Cordis nie trafia do
   przegladarki. Gdyby przyszly modul (np. `checkout`) potrzebowal
   podstrony-w-podstronie (np. edytor adresu bez przeladowania calej strony
   koszyka), TO byloby wlasciwe miejsce, zeby rozwazyc lekki client kernel -
   ale nie wczesniej.
5. **Granice paczki** (p. "wazny podzial paczki" w analizie) -> entrypoint
   `"."` pakietu `@shop/shared` NIE re-eksportuje `bridge.ts` (`export *`
   usuniete z `index.ts`). Kod server-only jest osiagalny WYLACZNIE przez
   jawne podsciezki (`@shop/shared/bridge`, `@shop/shared/request-scope`) -
   dokladnie mechanizm `exports` z analizy, majacy uniemozliwic przypadkowe
   wciagniecie kodu serwerowego do bundla przegladarki.

**Dodatkowa granica, ktorej analiza nie wspomina wprost, ale ktora tu ma
znaczenie:** manifest budowany przez kazdy modul (`nuxt.options.runtimeConfig.shopFeatures`)
jest zapisywany pod TOP-LEVEL `runtimeConfig`, nie pod `runtimeConfig.public`
- w Nuxcie to jedyna roznica miedzy "server-only" a "wysylane do klienta".
Manifest modulow (nazwy, prefiksy tras) nigdy nie trafia do przegladarki, bo
nigdy nie mial szansy - to wlasnosc konfiguracji, nie osobny mechanizm do
pilnowania.

**Lista antywzorcow z analizy, zweryfikowana wzgledem tego repo:**

- [x] brak "eager" barrela importujacego wszystkie moduly na raz - kazdy modul
  jest rejestrowany przez `defineNuxtModule`, ale sam kod strony/API jest
  ladowany przez Nitro leniwie (per route/chunk), nie eager-importowany z
  jednego pliku wejsciowego.
- [x] brak montowania calego grafu pluginow przy kazdym requescie - uslugi
  backendowe sa singletonami o czasie zycia procesu (punkt 2 wyzej).
- [x] brak instancji `Context`/serwisu w payloadzie SSR - `server/api/*.ts`
  zwraca wylacznie proste obiekty danych (`CartSnapshot`, `Product[]`), nigdy
  `ctx` ani klase serwisu.
- [x] brak jednego barrela eksportujacego kod server+client - patrz punkt 5.
- [x] brak wlasnego client runtime/registry slotow - patrz punkt 4.
- [x] brak dynamicznego pobierania zdalnego kodu do dzialajacego procesu -
  to byl JEDYNY prawdziwy naiwny blad w historii tego repo (`@shop/remote-sync`
  + R2/KV), juz usuniety i uzasadniony w Sekcji 8. Ta sama konkluzja z innej
  strony: "Ladowanie dowolnego zdalnego JavaScriptu jako czesc publicznej
  strony" i "wlasna implementacja lazy loadingu zamiast dynamicznych importow"
  sa wprost na liscie antywzorcow zrodlowej analizy.

Podsumowanie pokrywa sie z konkluzja zrodlowej analizy ("Cordis zarzadza
mozliwosciami produktu i zasobami, Nuxt zarzadza renderowaniem, routingiem,
chunkami oraz hydratacja"), przelozona na ksztalt tego repo: Cordis odpowiada
za kompozycje procesu (jakie uslugi backendowe istnieja, ktore moduly maja do
nich dostep, ktore moduly sa aktualnie WLACZONE, hot-swap calej appki bez
przestoju), Nuxt odpowiada za wszystko WEWNATRZ appki (routing, chunki,
renderowanie stron zlozonych z modulow) - i miedzy nimi nie powstal trzeci,
nakladajacy sie runtime.

## 11. Pivot: z trzech aplikacji Nuxt + brokera na jedna appke + Nuxt Modules {#pivot}

Poprzednia wersja tego repo (patrz `git log` sprzed tej zmiany) skladala sklep
z TRZECH niezaleznie budowanych aplikacji Nuxt (`apps/home`, `apps/product`,
`apps/cart` - kazda: wlasny port 3000-3002, wlasny `http.Server`), spinanych
`packages/broker` (reverse proxy HTTP kierujacy po prefiksie sciezki, patrz
usunieta Sekcja 4 - historia w `git log`) i `services/router-service`
(reaktywna tabela tras miedzy nimi). To dzialalo (zweryfikowane empirycznie -
patrz historia `README.md#status-weryfikacji`), ale zewnetrzna analiza (Sekcja
10) wykazala, ze broker + osobne porty to niepotrzebna duplikacja: Nuxt ma
JUZ wbudowany mechanizm build-time do skladania niezaleznie autorstwa
fragmentow w jedna appke (**Nuxt Modules**, `@nuxt/kit`), z wlasnym routingiem
i code-splittingiem - "budowanie cordisowego odpowiednika routera" (dokladnie
to, czym byl broker + router-service wzgledem trzech aplikacji) jest wprost
na liscie antywzorcow analizy.

**Co sie zmienilo:**

| Przed | Po |
|---|---|
| `apps/home`, `apps/product`, `apps/cart` (3 osobne aplikacje Nuxt, 3 porty) | `apps/shop` (JEDNA aplikacja Nuxt, 1 port) |
| `modules/home`, `modules/product`, `modules/cart` NIE istnialy | Nuxt Modules skladane w `apps/shop` przez `nuxt.config.ts` |
| `packages/broker` (HTTP reverse proxy) | USUNIETY - Nuxt sam routuje wewnatrz jednej appki |
| `services/router-service` (koefekt `router`) | USUNIETY - zastapiony przez `services/feature-registry-service` (koefekt `features`) o INNYM przeznaczeniu (widocznosc kodu, nie lokalizacja sieciowa) |
| 3 wpisy `@shop/nuxt-wrapper` w `cordis.yml` | 1 wpis `@shop/nuxt-wrapper` w `cordis.yml` |

**Co NIE sie zmienilo** (mechanizmy sprzed pivotu, ponownie uzyte bez modyfikacji):
`@shop/nuxt-wrapper` (Sekcja 1, wciaz "jeden zbudowany plik JS", teraz
uzywany raz zamiast trzy razy), `packages/shared/src/bridge.ts` (Sekcja 2,
identyczny mechanizm), `services/cart-service`/`services/product-service`
(Sekcja 3, wciaz niezalezne komponenty), make-before-break hot-reload (Sekcja
5, wciaz `config.watch` w `@shop/nuxt-wrapper`), model deploymentu (Sekcja 8,
juz byl "jeden obraz/jeden proces" - `deploy/docker/Dockerfile` potrzebowal
tylko listy `COPY`, nie zmiany podejscia).

**Nowy mechanizm, ktorego wczesniej nie bylo:** `services/feature-registry-service`
(koefekt `features`) - runtime-owe wlaczanie/wylaczanie JUZ ZBUDOWANEGO
modulu, bez rebuildu (Sekcja 4, `#feature-registry`). To bezposrednia
odpowiedz na pytanie "a co, jak bede chcial dorzucac funkcjonalnosci i
skladac je w trakcie zycia frontendu?" - odpowiedz brzmi: TAK, ale WYLACZNIE
dla kodu, ktory juz przeszedl build+review+CI (patrz rozroznienie w
`deploy/checkout-module-plan.md#6`), nigdy dla nowego, niezweryfikowanego
kodu pobieranego z sieci (to pozostaje zabronione, Sekcja 8).
