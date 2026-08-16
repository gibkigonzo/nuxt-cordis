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
- Ten sam mechanizm dziala identycznie dla aplikacji budowanej lokalnie
  (`apps/product`) i pobranej zdalnie przez `@shop/remote-sync`
  (`.remote-cache/<id>`) - artefakt to zawsze ten sam ksztalt katalogu
  (`<dir>/.output/server/index.mjs`).
- Bezposrednio odpowiada modelowi deploymentu z `deploy.md`: "moduly sa
  ladowane przez URL" - zbudowany plik JEST modulem.

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

## 8. Cloudflare Workers: co jest, a co NIE jest tam uruchomione {#cloudflare-workers}

`deploy.md` opisuje orchestrator dzialajacy "na Cloudflare Workers". To NIE
jest technicznie osiagalne dla TEGO procesu wprost:

- Workers nie maja `node:http`/wielu jednoczesnych `http.Server` (a wrapper
  otwiera jeden per instancja Nuxt),
- Workers nie maja dostepu do systemu plikow (a Nitro/Nuxt SSR + nasz bridge
  operuja na plikach `.output/server/*`),
- Workers nie moga dynamicznie `import()` dowolnego URL w runtime z pelnym
  Node-owym resolverem modulow.

**Co faktycznie dziala na Cloudflare** w tym repo: **R2** (przechowywanie
zbudowanych artefaktow, `deploy/workflows/deploy-module.yml`) i **KV +
Worker** (`deploy/cloudflare/manifest-worker`) jako "source of truth" configu.
Sam **orchestrator dziala na zwyklym, dlugozyjacym hoscie Node** (VM, Docker,
Fly.io, Render - patrz `deploy/README.md`), gdzie `@shop/remote-sync`
okresowo odpytuje Workera i sam decyduje, co przeladowac - **bez** restartu
calego procesu. To w pelni realizuje SENS `deploy.md` (build tylko zmienionego
modulu, brak przestoju pozostalych, brak "cold start" calej aplikacji), tylko
bez dosl ownego "orchestrator jako Worker".

Mechanizm `@shop/remote-sync` (`ctx.loader.create/update/remove` sterowane
zdalnym manifestem) zostal empirycznie zweryfikowany lokalnie z mockiem
API Cloudflare (`deploy/scripts/mock-registry-server.mjs`) - patrz
`README.md#status-weryfikacji` po dokladny zakres tego, co jest sprawdzone
end-to-end, a co (Worker na prawdziwym koncie Cloudflare) pozostaje do
weryfikacji przed produkcyjnym uzyciem.

## 9. Graceful shutdown

`orchestrator/src/index.ts` lapie `SIGINT`/`SIGTERM` i woła `ctx.fiber.dispose()`
na fiberze glownego kontekstu - kaskadowo cofa efekty calego drzewa komponentow
w kolejnosci LIFO (Theorem 16/66 papieru: recovery exactness + gwarantowane
osiagniecie stanu spoczynkowego). Zweryfikowane: `docker stop` zamyka caly
system (3 serwery HTTP + wyrejestrowanie tras) w ~160ms, bez wymuszonego
`SIGKILL`.
