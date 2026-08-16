import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join, resolve, isAbsolute, dirname, basename } from 'node:path'
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
   * Tryb deweloperski: obserwuj zbudowany plik i restartuj fiber (ctx.fiber.restart())
   * po kazdej zmianie - np. rownolegle z `nuxi build --watch` danej aplikacji.
   * W deploymencie zdalnym (deploy.md, ladowanie modulow z URL) zostaw wylaczone -
   * tam przeladowanie wyzwala zmiana deklaratywnego configu, nie system plikow.
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

/**
 * Uruchamia jedna zbudowana aplikacje Nuxt jako rewersyjny efekt Cordis: import
 * zbudowanego pliku (Nitro preset `node-listener`) + `http.createServer(listener).listen(port)`,
 * z odwrotnoscia `server.close()`. Aktywacja jest zbramkowana koefektami z `config.inject`
 * (Theorem 63 w pracy o Cordis: instancja startuje dopiero gdy jej zaleznosci sa dostepne).
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
    ctx2.effect(async function* () {
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
      const specifier = toBridgedSpecifier(entryHref, config.id)

      // Etap 1: rejestracja mostu (bridge) - musi byc widoczna, zanim wykona sie
      // top-level kod zbundlowanej aplikacji, ktory go odczytuje (plugin Nitro).
      setBridge(config.id, ctx2)
      yield () => deleteBridge(config.id)

      // Etap 2: import zbudowanego modulu (query string niesie id + cache-bust dla HMR)
      // i uzyskanie golego node-listenera wyeksportowanego przez preset node-listener.
      const mod = (await import(/* @vite-ignore */ specifier)) as BuiltModuleExports
      const listener = mod.listener ?? mod.handler
      if (typeof listener !== 'function') {
        throw new Error(
          `[nuxt-wrapper:${config.id}] zbudowany modul nie eksportuje 'listener'. ` +
          `Upewnij sie, ze nitro.preset = 'node-listener' w nuxt.config.ts.`,
        )
      }

      // Etap 3: wlasny http.Server wokol listenera - to My kontrolujemy port/host oraz
      // uchwyt do close(), niezaleznie od tego, jak preset node-listener jest zbudowany.
      const server = createServer(listener as never)
      await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(config.port, host, () => {
          server.off('error', reject)
          resolvePromise()
        })
      })
      ctx2.logger.info(`[${config.id}] nasluchuje na http://${host}:${config.port} (${dir})`)

      yield async () => {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
        ctx2.logger.info(`[${config.id}] zatrzymany`)
      }
    }, `nuxt:${config.id}`)

    // Watcher rekompilacji (opcjonalny, config.watch): niezalezny efekt obserwujacy
    // katalog zbudowanego pliku. Restart fibera przez natywny Fiber#restart() Cordisa
    // sam w sobie jest cofnieciem starego efektu (server.close(), deleteBridge) i
    // ponownym wykonaniem calego generatora powyzej - a poniewaz kazde wywolanie
    // generuje SWIEZY, cache-bustowany specyfikator importu, nowy build jest zawsze
    // widziany, bez potrzeby recznego czyszczenia cache modulow ESM.
    if (config.watch) {
      ctx2.effect(() => {
        const dir = resolveDir(ctx2, config.dir)
        const entryPath = join(dir, entryRel)
        const watchDir = dirname(entryPath)
        const entryName = basename(entryPath)
        let timer: ReturnType<typeof setTimeout> | undefined

        const watcher = chokidarWatch(watchDir, { ignoreInitial: true, depth: 0 })
        watcher.on('all', (_event, path) => {
          if (basename(path) !== entryName) return
          clearTimeout(timer)
          timer = setTimeout(() => {
            ctx2.logger.info(`[${config.id}] wykryto nowy build, restartuje fiber…`)
            void ctx2.fiber.restart()
          }, 300)
        })

        return async () => {
          clearTimeout(timer)
          await watcher.close()
        }
      }, `watch:${config.id}`)
    }

    // Etap 4 (opcjonalny): rejestracja w RouterService, jesli podano prefiks trasy
    // i usluga routera jest wstrzykiwana. Odbywa sie jako NIEZALEZNY efekt na tym
    // samym ctx2, wiec jego cofniecie (wyrejestrowanie trasy) jest niezalezne od
    // odwrocenia efektu serwera - a oba sa cofane w kolejnosci LIFO wzgledem siebie.
    if (config.route && inject.includes('router')) {
      ctx2.effect(() => {
        const router = ctx2.get('router')
        const dispose = router?.register(config.route as string, { host, port: config.port, id: config.id })
        return () => dispose?.()
      }, `route:${config.id}`)
    }
  })
}

export const name = 'nuxt-wrapper'

export default { name, inject: [], apply }
