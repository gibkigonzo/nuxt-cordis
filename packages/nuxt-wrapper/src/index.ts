import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { watch as chokidarWatch } from 'chokidar'
import type { Context } from 'cordis'
import { setBridge, deleteBridge, toBridgedSpecifier } from '@shop/shared/bridge'

export interface NuxtWrapperConfig {
  /** identyfikator instancji (stabilny, uzywany do bridge/routera/logow) */
  id: string
  /** sciezka do katalogu aplikacji Nuxt (zawierajacego .output/server/*) */
  dir: string
  /** sciezka do zbudowanego pliku wzgledem `dir` (domyslnie .output/server/index.mjs) */
  entry?: string
  /** port TCP, na ktorym instancja ma nasluchiwac */
  port: number
  /** adres nasluchu (domyslnie 127.0.0.1) */
  host?: string
  /** koefekty wymagane przed aktywacja (np. ['cart']) */
  inject?: string[]
  /** prefiks sciezki rejestrowany w RouterService (np. '/product') */
  route?: string
  /**
   * Tryb deweloperski: obserwuj zbudowany plik i podmien instancje "make-before-break"
   * po kazdej zmianie (nowy serwer na porcie efemerycznym obok jeszcze dzialajacego
   * starego, przelaczenie routera, dopiero potem zamkniecie starego) - np. rownolegle
   * z `nuxi build --watch` danej aplikacji. Zero przestoju TEGO modulu podczas wlasnego
   * przeladowania, nie tylko brak wplywu na pozostale (patrz ARCHITECTURE.md).
   */
  watch?: boolean
}

interface BuiltModuleExports {
  listener?: (req: unknown, res: unknown) => void
  handler?: (req: unknown, res: unknown) => void
}

function resolveDir(ctx: Context, dir: string): string {
  if (isAbsolute(dir)) return dir
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, dir)
}

interface ActiveInstance {
  server: ReturnType<typeof createServer>
  port: number
}

/**
 * Uruchamia jedna zbudowana aplikacje Nuxt jako rewersyjny efekt Cordis: import
 * zbudowanego pliku (Nitro preset `node-listener`) + `http.createServer(listener).listen(port)`,
 * z odwrotnoscia `server.close()`. Aktywacja jest zbramkowana koefektami z `config.inject`
 * (Theorem 63 w pracy o Cordis: instancja startuje dopiero gdy jej zaleznosci sa dostepne).
 *
 * Podmiana instancji (config.watch) jest "make-before-break", nie dispose-then-create:
 * nowy serwer wstaje na porcie efemerycznym OBOK jeszcze dzialajacego starego, router
 * jest przelaczany dopiero gdy nowy faktycznie nasluchuje, a stary jest zamykany
 * DOPIERO POTEM - `server.close()` odsacza trwajace polaczenia zamiast je zrywac, wiec
 * zaden request w locie nie jest gubiony (Section 6.2 papieru Cordis: nowy provider
 * ACTIVE -> przelaczenie ruchu -> dispose starego).
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
    // Most (bridge) jest wspolny dla WSZYSTKICH kolejnych instancji tego samego `id`
    // w ramach zycia tego fibera - ten sam ctx2 nie zmienia sie miedzy podmianami,
    // wiec rejestrujemy go RAZ tutaj (nie przy kazdym reloadzie w activate() ponizej)
    // i usuwamy dopiero w teardown, gdy caly fiber jest ostatecznie dysponowany -
    // request wciaz doplywajacy do STAREJ instancji podczas jej drenowania nadal
    // potrzebuje dzialajacego mostu pod tym samym `id`.
    setBridge(config.id, ctx2)

    let active: ActiveInstance | undefined
    let unregisterRoute: (() => void) | undefined
    // `disposed` odcina KAZDA aktywacje w toku (nawet zakolejkowana, patrz
    // activationChain nizej) w momencie, gdy fiber jest dysponowany - bez tego
    // aktywacja zakonczona PO teardownie odtworzylaby serwer/wpis w routerze,
    // ktorych juz nic pozniej by nie posprzatalo (bridge dla `config.id` jest
    // wtedy juz usuniety, wiec taka "ozywiona" instancja i tak nie moglaby
    // obslugiwac requestow).
    let disposed = false
    // Serializuje wszystkie wywolania activate() (poczatkowy boot ORAZ kazde
    // kolejne wywolanie z watchera) - bez tego dwa rownolegle activate() (np.
    // watcher odpala sie, zanim poczatkowy boot zdazyl ustawic `active`) oba
    // widza `active === undefined`, oba licza `bindPort = config.port` i
    // wpadaja w wyscig o ten sam port (EADDRINUSE dla przegranego).
    let activationChain: Promise<void> = Promise.resolve()

    const registerRoute = (port: number) => {
      if (!config.route || !inject.includes('router')) return
      const router = ctx2.get('router')
      // Router.register() z tym samym `id` co poprzednio NADPISUJE wpis (patrz
      // services/router-service) - stary, nigdy-niewywolany disposer jest bezpiecznie
      // martwy, bo jego wewnetrzny check referencji nie trafi juz w nowy wpis.
      unregisterRoute = router?.register(config.route as string, { host, port, id: config.id })
    }

    /**
     * Buduje i uruchamia NOWA instancje na porcie efemerycznym (OS przydziela wolny
     * port przy pierwszym boocie uzywamy `config.port`, przy kazdej kolejnej podmianie
     * `0` - zeby nowa instancja mogla wystartowac OBOK jeszcze dzialajacej starej).
     * Dopiero gdy nowa faktycznie nasluchuje, router jest przelaczany na nia - i
     * DOPIERO POTEM zamykana jest stara. Wolane WYLACZNIE przez `activate()` ponizej,
     * ktore serializuje wywolania - nigdy bezposrednio.
     */
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
      // Fiber mogl zostac dysponowany, gdy czekalismy na import() - jeszcze nic nie
      // otworzylismy, wiec wystarczy po prostu wyjsc.
      if (disposed) return

      const listener = mod.listener ?? mod.handler
      if (typeof listener !== 'function') {
        throw new Error(
          `[nuxt-wrapper:${config.id}] zbudowany modul nie eksportuje 'listener'. ` +
          `Upewnij sie, ze nitro.preset = 'node-listener' w nuxt.config.ts.`,
        )
      }

      const server = createServer(listener as never)
      const bindPort = active ? 0 : config.port
      await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(bindPort, host, () => {
          server.off('error', reject)
          resolvePromise()
        })
      })
      if (disposed) {
        // Fiber zostal dysponowany, gdy serwer juz nasluchiwal - zamknij go od razu,
        // NIE dotykaj `active`/routera (te sa juz posprzatane przez teardown).
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
        return
      }

      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : bindPort

      const previous = active
      active = { server, port }
      ctx2.logger.info(
        previous
          ? `[${config.id}] nowa instancja nasluchuje na http://${host}:${port}, przelaczam ruch...`
          : `[${config.id}] nasluchuje na http://${host}:${port} (${dir})`,
      )
      try {
        // Od tej chwili NOWY ruch trafia do nowej instancji (Map.set jest atomowe w
        // jednowatkowym event loopie Node - brak okna z niespojnym stanem).
        registerRoute(port)
      } finally {
        // W `finally`, zeby stara instancja zostala zamknieta NAWET jesli
        // registerRoute() rzuci (np. router.register() na zajetym przez inny `id`
        // prefiksie) - inaczej `previous` zostaje otwarty na zawsze, bez zadnej
        // referencji, ktora mogla by go pozniej zamknac.
        if (previous) {
          // server.close() przestaje przyjmowac NOWE polaczenia, ale odsacza (drain)
          // te juz trwajace - zaden request w locie do starej instancji nie jest zrywany.
          await new Promise<void>((resolvePromise) => previous.server.close(() => resolvePromise()))
          ctx2.logger.info(`[${config.id}] stara instancja (${previous.port}) zamknieta - podmiana zakonczona`)
        }
      }
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
        // inaczej mogla by dokonczyc sie PO tym teardownie i odtworzyc serwer/
        // wpis w routerze, ktorych juz nic by nie posprzatalo.
        await activationChain.catch(() => {})
        unregisterRoute?.()
        deleteBridge(config.id)
        if (active) {
          await new Promise<void>((resolvePromise) => active!.server.close(() => resolvePromise()))
          ctx2.logger.info(`[${config.id}] zatrzymany`)
          active = undefined
        }
      }
    }, `nuxt:${config.id}`)

    // Watcher rekompilacji (opcjonalny, config.watch): niezalezny efekt obserwujacy
    // katalog aplikacji. Wola activate() BEZPOSREDNIO (nie Fiber#restart()) -
    // make-before-break powyzej, zamiast dispose-then-create na tym samym porcie.
    // Zepsuty rebuild (np. blad importu) NIE zabiera dzialajacej instancji: blad jest
    // tylko logowany, stara instancja zostaje aktywna.
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
        // `dir` (katalog aplikacji, np. apps/product) sam nigdy nie jest kasowany,
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
            ctx2.logger.info(`[${config.id}] wykryto nowy build, uruchamiam nowa instancje obok starej...`)
            activate().catch((error) => {
              ctx2.logger.warn(`[${config.id}] nie udalo sie przelaczyc na nowy build: ${(error as Error).message}`)
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
