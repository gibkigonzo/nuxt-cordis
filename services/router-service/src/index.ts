import { Service, type Context } from 'cordis'
import type { RouteTarget } from '@shop/shared'

declare module 'cordis' {
  interface Context {
    router: RouterService
  }
}

/**
 * RouterService: koefekt 'router'. Trzyma zywa, reaktywna tabele tras
 * (prefiks sciezki -> {host, port}). Instancje aplikacji rejestruja sie same
 * (patrz @shop/nuxt-wrapper, config.route) przy aktywacji i wyrejestrowuja przy
 * dezaktywacji - broker (packages/broker) zawsze widzi aktualny stan bez
 * potrzeby wlasnej rekonfiguracji czy restartu.
 */
export class RouterService extends Service {
  routes: Map<string, RouteTarget>

  constructor(ctx: Context) {
    super(ctx, 'router')
    this.routes = new Map()
  }

  /** @returns disposer wyrejestrowujacy trase */
  register(prefix: string, target: RouteTarget): () => void {
    const existing = this.routes.get(prefix)
    if (existing && existing.id !== target.id) {
      throw new Error(`[router] trasa "${prefix}" jest juz zajeta przez instancje "${existing.id}"`)
    }
    this.routes.set(prefix, target)
    this.ctx.logger.info(`[router] ${prefix} -> ${target.id} (http://${target.host}:${target.port})`)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.routes.get(prefix) === target) {
        this.routes.delete(prefix)
        this.ctx.logger.info(`[router] ${prefix} wyrejestrowany (byl: ${target.id})`)
      }
    }
  }

  /**
   * Dopasowanie po najdluzszym pasujacym prefiksie sciezki. Zwraca takze sam
   * dopasowany prefiks (dla logow/listy tras w brokerze) - NIE do odciecia:
   * broker przekazuje `req.path` upstreamowi BEZ ZMIAN, bo kazda instancja Nuxt
   * zna wlasny prefiks przez `app.baseURL` i Nitro sam dopasowuje trasy wzgledem
   * niego (odciecie tutaj powodowaloby petle przekierowan 302 - patrz
   * ARCHITECTURE.md#4 i CLAUDE.md, gotcha 4).
   */
  resolve(pathname: string): (RouteTarget & { prefix: string }) | undefined {
    let best: RouteTarget | undefined
    let bestPrefix = ''
    let bestLen = -1
    for (const [prefix, target] of this.routes) {
      const matches = prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/')
      if (matches && prefix.length > bestLen) {
        best = target
        bestPrefix = prefix
        bestLen = prefix.length
      }
    }
    return best ? { ...best, prefix: bestPrefix } : undefined
  }

  list(): Array<{ prefix: string } & RouteTarget> {
    return [...this.routes.entries()].map(([prefix, target]) => ({ prefix, ...target }))
  }
}

export default RouterService
