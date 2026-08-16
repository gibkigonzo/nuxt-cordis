import type { Context } from 'cordis'
import Server, { type Request, type Response } from '@cordisjs/plugin-server'
// import samych deklaracji `declare module 'cordis'` z router-service (augmentacja ctx.router
// dla edytora/TS) - `import type` jest zawsze usuwany przez type-stripping, wiec brak wplywu na runtime.
import type {} from '@shop/router-service'

export interface BrokerConfig {
  host?: string
  port: number
  maxPort?: number
}

export const name = 'broker'
export const inject = ['router']

/**
 * Service Broker (Section 6.2 papieru Cordis): pojedyncza brama HTTP kierujaca
 * ruch do wlasciwej instancji Nuxt na podstawie prefiksu sciezki, odczytanego z
 * reaktywnej tabeli tras (koefekt 'router', patrz @shop/router-service). Zaden
 * routing nie jest zakodowany na sztywno - kazda instancja Nuxt rejestruje /
 * wyrejestrowuje sie sama przy aktywacji/dezaktywacji swojego fibera, wiec broker
 * automatycznie "widzi" nowo dodane moduly (np. czwarty modul z deploy.md) bez
 * wlasnej rekonfiguracji czy restartu.
 *
 * Broker sam jest zwyklym komponentem Cordis, wiec moze byc aktualizowany "w locie"
 * (HMR) tak samo jak kazda inna czesc systemu.
 */
export function apply(ctx: Context, config: BrokerConfig): void {
  ctx.plugin(Server, {
    host: config.host ?? '0.0.0.0',
    port: config.port,
    maxPort: config.maxPort,
  })

  ctx.inject(['server', 'router'], (ctx2) => {
    ctx2.effect(() => {
      // ctx.server.all(...) zwraca obiekt HttpRoute (z metoda .dispose), nie goly
      // disposer - ctx.effect wymaga funkcji wywolywalnej jako odwrotnosc efektu.
      const route = ctx2.server.all('{/*splat}', async (req, res) => {
        await handle(ctx2, req, res)
      })
      return () => route.dispose()
    }, 'broker:gateway')
  })
}

async function handle(ctx: Context, req: Request, res: Response): Promise<void> {
  const target = ctx.router.resolve(req.path)
  if (!target) {
    res.status = 502
    res.headers.set('content-type', 'text/plain; charset=utf-8')
    res.body = `[broker] brak zarejestrowanej trasy dla "${req.path}".\n\nDostepne trasy:\n${
      ctx.router.list().map((r) => `  ${r.prefix} -> ${r.id} (http://${r.host}:${r.port})`).join('\n') || '  (brak)'
    }`
    return
  }

  // Sciezka jest przekazywana BEZ zmian (bez odcinania prefiksu): kazda aplikacja
  // Nuxt zna wlasny prefiks poprzez `app.baseURL` w nuxt.config.ts i Nitro sam
  // dopasowuje trasy wzgledem niego. Odciecie prefiksu tutaj powodowaloby, ze
  // upstream (majac skonfigurowane baseURL np. '/product/') przekierowywalby
  // (302) kazdy request z powrotem na prefiksowana sciezke - petla przekierowan.
  const search = req.query.toString()
  const upstreamUrl = `http://${target.host}:${target.port}${req.path}${search ? `?${search}` : ''}`
  const isBodyless = req.method === 'GET' || req.method === 'HEAD'
  const headers = new Headers(req.headers)
  headers.delete('host')

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: isBodyless ? undefined : req.body,
      // @ts-expect-error wymagane przez undici gdy body jest strumieniem
      duplex: isBodyless ? undefined : 'half',
      redirect: 'manual',
    })
  } catch (error) {
    ctx.logger.warn(`[broker] instancja "${target.id}" (${target.host}:${target.port}) nie odpowiada: ${(error as Error).message}`)
    res.status = 503
    res.headers.set('content-type', 'text/plain; charset=utf-8')
    res.body = `[broker] instancja "${target.id}" jest chwilowo niedostepna (trwa reload lub padla).`
    return
  }

  res.status = upstreamRes.status
  for (const [key, value] of upstreamRes.headers) {
    if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') continue
    res.headers.set(key, value)
  }
  res.body = upstreamRes.body
}

export default { name, inject, apply }
