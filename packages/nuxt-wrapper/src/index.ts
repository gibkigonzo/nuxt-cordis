import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { watch as chokidarWatch } from 'chokidar'
import type { Context } from 'cordis'
import { setBridge, deleteBridge, toBridgedSpecifier } from '@shop/shared/bridge'

export interface NuxtWrapperConfig {
  /** identyfikator instancji (stabilny, uzywany do bridge/logow) */
  id: string
  /** sciezka do katalogu aplikacji Nuxt (zawierajacego .output/server/*) */
  dir: string
  /** sciezka do zbudowanego pliku wzgledem `dir` (domyslnie .output/server/index.mjs) */
  entry?: string
  /** port TCP, na ktorym instancja ma nasluchiwac */
  port: number
  /** adres nasluchu (domyslnie 127.0.0.1 - ustaw '0.0.0.0', zeby przyjmowac polaczenia spoza hosta/kontenera) */
  host?: string
  /** koefekty wymagane przed aktywacja (np. ['cart']) */
  inject?: string[]
  /**
   * Tryb deweloperski: obserwuj zbudowany plik i podmien wewnetrzny listener
   * po kazdej zmianie (patrz docstring ponizej) - np. rownolegle z
   * `nuxi build --watch` danej aplikacji.
   */
  watch?: boolean
}

interface BuiltModuleExports {
  listener?: (req: unknown, res: unknown) => void
  handler?: (req: unknown, res: unknown) => void
}

type Listener = (req: unknown, res: unknown) => void

function resolveDir(ctx: Context, dir: string): string {
  if (isAbsolute(dir)) return dir
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, dir)
}

/**
 * Uruchamia jedna zbudowana aplikacje Nuxt jako rewersyjny efekt Cordis: import
 * zbudowanego pliku (Nitro preset `node-listener`) + delegacja requestow do
 * JEDNEGO, TRWALEGO `http.Server` otwartego RAZ na `config.port` przy
 * pierwszej udanej aktywacji, z odwrotnoscia `server.close()` przy dispose
 * calego fibera. Aktywacja jest zbramkowana koefektami z `config.inject`
 * (Theorem 63 w pracy o Cordis: instancja startuje dopiero gdy jej
 * zaleznosci sa dostepne).
 *
 * Hot-reload (config.watch) NIE otwiera nowego serwera/portu: podmienia
 * WYLACZNIE wewnetrzna referencje `currentListener`, do ktorej trwale
 * nasluchujacy `server` deleguje kazdy request. To prawdziwe zero-downtime -
 * poniewaz JS jest jednowatkowy, request juz w trakcie obslugi zdazyl
 * wywolac `listener(req, res)` z KONKRETNYM odwolaniem do funkcji, wiec
 * podmiana zmiennej `currentListener` pozniej go nie dotyczy (dokonczy sie
 * na starej wersji kodu) - kazdy NOWY request po podmianie trafia od razu
 * do nowego kodu. Zaden zewnetrzny proces (broker, reverse proxy) nie jest
 * potrzebny do zachowania stabilnego publicznego portu podczas podmiany.
 *
 * Gotcha odkryta w tej sesji (code review po pivocie na jedna appke Nuxt,
 * patrz ARCHITECTURE.md#10-11): wczesniejsza wersja tego pliku otwierala
 * NOWY serwer na porcie EFEMERYCZNYM przy kazdym reloadzie i zamykala
 * poprzedni - poprawne WYLACZNIE gdy broker po drugiej stronie odczytywal
 * reaktywna tabele tras i przekierowywal ruch na nowy port. Po usunieciu
 * brokera (jedna appka Nuxt sama routuje wewnatrz siebie) nic juz nie
 * wykonywalo tego przekierowania - appka stawala sie CALKOWICIE i CICHO
 * nieosiagalna po PIERWSZYM hot-reloadzie w trybie dev (`cordis.dev.yml`),
 * bo `config.port` przestawal miec cokolwiek nasluchujacego. Ten plik
 * (jeden trwaly serwer + podmieniana referencja) jest poprawny dla
 * DOWOLNEJ liczby niezaleznych instancji (kazda dostaje wlasny, stabilny
 * port) - nie tylko dla obecnego przypadku jednej appki.
 */
export function apply(ctx: Context, config: NuxtWrapperConfig): void {
  if (!config?.id) throw new Error('[nuxt-wrapper] config.id jest wymagane')
  if (!config?.dir) throw new Error('[nuxt-wrapper] config.dir jest wymagane')
  if (!config?.port) throw new Error('[nuxt-wrapper] config.port jest wymagane')

  const inject = config.inject ?? []
  const host = config.host ?? '127.0.0.1'
  const entryRel = config.entry ?? '.output/server/index.mjs'

  // ctx.inject zbramkowuje caly poddrzewny fiber koefektami: instancja Nuxt aktywuje sie
  // dopiero gdy wszystkie deklarowane zaleznosci sa dostarczone (i deaktywuje, gdy przestana byc).
  ctx.inject(inject, (ctx2) => {
    // Most (bridge) jest wspolny dla WSZYSTKICH kolejnych podmian kodu w ramach
    // zycia tego fibera - ten sam ctx2 nie zmienia sie miedzy nimi, wiec
    // rejestrujemy go RAZ tutaj i usuwamy dopiero w teardown, gdy caly fiber
    // jest ostatecznie dysponowany.
    setBridge(config.id, ctx2)

    let currentListener: Listener | undefined
    let listening = false
    let activationCount = 0
    // `disposed` odcina KAZDA aktywacje w toku w momencie, gdy fiber jest
    // dysponowany - bez tego aktywacja zakonczona PO teardownie mogloby
    // podmienic `currentListener` na serwerze, ktory teardown wlasnie zamyka.
    let disposed = false
    // Serializuje wszystkie wywolania activate() (poczatkowy boot ORAZ kazde
    // kolejne wywolanie z watchera) - bez tego dwa rownolegle rebuildy moglyby
    // podmienic `currentListener` w nieprzewidywalnej kolejnosci (najnowszy
    // build mogl przegrac wyscig z wolniejszym starszym).
    let activationChain: Promise<void> = Promise.resolve()

    // Trwaly serwer, tworzony RAZ dla calego zycia fibera - deleguje kazdy
    // request do `currentListener` (patrz docstring wyzej). `server.listen()`
    // jest wolane dopiero wewnatrz PIERWSZEGO udanego doActivate(), nie tutaj -
    // zeby port NIE zostal zajety, jesli sam pierwszy build okaze sie zepsuty.
    const server = createServer((req, res) => {
      if (!currentListener) {
        res.statusCode = 503
        res.end('[nuxt-wrapper] instancja jeszcze sie nie uruchomila')
        return
      }
      currentListener(req as never, res as never)
    })

    const doActivate = async (): Promise<void> => {
      if (disposed) return

      const dir = resolveDir(ctx2, config.dir)
      const entryPath = join(dir, entryRel)
      if (!existsSync(entryPath)) {
        throw new Error(
          `[nuxt-wrapper:${config.id}] brak zbudowanego pliku ${entryPath}.\n` +
          `Zbuduj najpierw aplikacje: pnpm --filter ${config.id} run build\n` +
          `(nitro.preset musi byc ustawiony na "node-listener")`,
        )
      }

      const entryHref = pathToFileURL(entryPath).href
      // Kazda aktywacja dostaje SWIEZY, cache-bustowany specyfikator (?t=<timestamp>) -
      // Node'owy loader ESM cache'uje moduly po dokladnym URL, wiec bez tego kolejny
      // build nie zostalby nigdy zobaczony.
      const specifier = toBridgedSpecifier(entryHref, config.id)

      const mod = (await import(/* @vite-ignore */ specifier)) as BuiltModuleExports
      // Fiber mogl zostac dysponowany, gdy czekalismy na import() - `currentListener`
      // nie zostal jeszcze podmieniony, wiec wystarczy po prostu wyjsc (teardown
      // zamknie caly serwer osobno).
      if (disposed) return

      const listener = mod.listener ?? mod.handler
      if (typeof listener !== 'function') {
        throw new Error(
          `[nuxt-wrapper:${config.id}] zbudowany modul nie eksportuje 'listener'. ` +
          `Upewnij sie, ze nitro.preset = 'node-listener' w nuxt.config.ts.`,
        )
      }

      if (!listening) {
        await new Promise<void>((resolvePromise, reject) => {
          server.once('error', reject)
          server.listen(config.port, host, () => {
            server.off('error', reject)
            resolvePromise()
          })
        })
        if (disposed) {
          await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
          return
        }
        listening = true
      }

      // Podmiana atomowa - JS jest jednowatkowy, wiec zaden request nie moze
      // "zobaczyc" mieszanki starego i nowego kodu (patrz docstring wyzej).
      currentListener = listener as Listener
      activationCount += 1
      ctx2.logger.info(
        activationCount === 1
          ? `[${config.id}] nasluchuje na http://${host}:${config.port} (${dir})`
          : `[${config.id}] nowy build zaladowany (hot-reload) - nadal nasluchuje na http://${host}:${config.port}`,
      )
    }

    const activate = (): Promise<void> => {
      const run = activationChain.catch(() => {}).then(doActivate)
      // Kolejny caller czeka na TEN run (sukces lub blad ignorowany tylko na
      // potrzeby samego lancucha) - blad z `run` i tak trafia do TEGO callera,
      // ktory na niego czeka bezposrednio.
      activationChain = run.catch(() => {})
      return run
    }

    ctx2.effect(async () => {
      await activate()
      return async () => {
        disposed = true
        // Czekaj, az kazda aktywacja w toku/zakolejkowana faktycznie sie zakonczy
        // (normalnie, lub przez wczesne wyjscie z powodu `disposed` powyzej) -
        // inaczej mogla by dokonczyc sie PO tym teardownie i podmienic
        // `currentListener` na serwerze, ktory ponizej wlasnie zamykamy.
        await activationChain.catch(() => {})
        deleteBridge(config.id)
        if (listening) {
          await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
          ctx2.logger.info(`[${config.id}] zatrzymany`)
        }
      }
    }, `nuxt:${config.id}`)

    // Watcher rekompilacji (opcjonalny, config.watch): niezalezny efekt obserwujacy
    // katalog aplikacji. Wola activate() BEZPOSREDNIO (nie Fiber#restart()).
    // Zepsuty rebuild (np. blad importu) NIE zabiera dzialajacej instancji: blad jest
    // tylko logowany, `currentListener` zostaje niezmieniony (stary kod nadal dziala).
    if (config.watch) {
      ctx2.effect(() => {
        const dir = resolveDir(ctx2, config.dir)
        const entryPath = resolve(join(dir, entryRel))
        let timer: ReturnType<typeof setTimeout> | undefined

        // Watchowany jest KATALOG APLIKACJI (`dir`), NIE `dirname(entryPath)`
        // (`.output/server`) - Nitro/Nuxt kasuje `.output` w calosci na starcie
        // builda i odtwarza je od zera na koncu (rm -rf + mkdir), a surowy fs.watch
        // pod spodem chokidar NIE odzyskuje sledzenia katalogu, ktory zostal
        // usuniety i odtworzony pod tym samym sciezka - zaobserwowane empirycznie:
        // watcher na `.output/server` wylapywal TYLKO pierwsze zdarzenie (usuniecie),
        // aktywacja poprawnie failowala bezpiecznie (stara instancja dzialala dalej),
        // ale kolejne, docelowe zdarzenie (finalny zapis index.mjs) nigdy juz nie
        // przychodzilo - modul zostawal utkniety na starym kodzie bez zadnego bledu.
        // `dir` (katalog aplikacji, np. apps/shop) sam nigdy nie jest kasowany,
        // wiec chokidar prawidlowo widzi `.output` znikajace i pojawiajace sie na
        // nowo w jego wnetrzu. `depth` jest ograniczony do liczby segmentow
        // `entryRel`, zeby nie rekurowac bez potrzeby w glab (np. `.nuxt/**`).
        const depth = entryRel.split(/[\\/]/).length
        // `usePolling` (zamiast natywnego fs.watch/inotify pod spodem) jest tu
        // celowe, nie kosmetyczne: zaobserwowane empirycznie, ze natywny watcher
        // CZASAMI (nie zawsze) gubi zdarzenie koncowego zapisu `index.mjs` po tym,
        // jak Nitro usuwa i odtwarza caly katalog `.output` w trakcie builda -
        // zalezne od czasu systemu plikow/OS, nie deterministyczne. Polling co
        // `interval` ms nie ma tej wady kosztem (pomijalnego dla jednego watchowanego
        // pliku per aplikacje) uzycia CPU w trybie dev.
        const watcher = chokidarWatch(dir, {
          ignoreInitial: true,
          depth,
          ignored: (path: string) => /[\\/](node_modules|\.git)([\\/]|$)/.test(path),
          usePolling: true,
          interval: 300,
        })
        watcher.on('all', (_event, path) => {
          if (resolve(path) !== entryPath) return
          clearTimeout(timer)
          timer = setTimeout(() => {
            ctx2.logger.info(`[${config.id}] wykryto nowy build, ladujem nowy kod...`)
            activate().catch((error) => {
              ctx2.logger.warn(`[${config.id}] nie udalo sie zaladowac nowego builda: ${(error as Error).message}`)
            })
          }, 300)
        })

        return async () => {
          clearTimeout(timer)
          await watcher.close()
        }
      }, `watch:${config.id}`)
    }
  })
}

export const name = 'nuxt-wrapper'

export default { name, inject: [], apply }
