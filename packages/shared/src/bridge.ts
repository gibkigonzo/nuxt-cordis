import type { Context } from 'cordis'

// Kazda aplikacja Nuxt jest budowana Nitro-presetem `node-listener` do POJEDYNCZEGO
// zbundlowanego pliku JS (patrz packages/nuxt-wrapper). Ten plik jest wlasnym,
// odrebnym grafem modulow (Nitro bundluje wszystkie swoje zaleznosci), wiec nie moze
// bezposrednio zaimportowac zywego obiektu `ctx` orkiestratora Cordis - zyje on w
// INNYM module (nuxt-wrapper), choc w TYM SAMYM procesie Node.
//
// "Bridge" rozwiazuje to przez jeden, znany globalny rejestr trzymany na `globalThis`
// pod kluczem z globalnego rejestru symboli (Symbol.for), wiec dziala niezaleznie od
// tego, przez ktora kopie tego pakietu zostal zaimportowany (workspace hoisting itp).
//
// Identyfikator (klucz bridge'a) jest osadzony w SAMYM specyfikatorze importu
// (`?cordis=<id>&t=<timestamp>`), a nie w zmiennej srodowiskowej - dzieki temu
// rownolegle ladowanie kilku instancji w jednym procesie jest wolne od race condition:
// `import.meta.url` wewnatrz zbundlowanego pliku zawsze odpowiada dokladnie temu
// specyfikatorowi, ktorym ten konkretny import zostal wywolany.

const BRIDGE_KEY = Symbol.for('shop.cordis.bridge.v1')

interface GlobalWithBridge {
  [BRIDGE_KEY]?: Map<string, Context>
}

function registry(): Map<string, Context> {
  const g = globalThis as GlobalWithBridge
  return (g[BRIDGE_KEY] ??= new Map())
}

/**
 * Rejestruje zywy kontekst Cordis pod danym id, TUZ PRZED wywolaniem `import()`
 * zbudowanego modulu aplikacji.
 */
export function setBridge(id: string, ctx: Context): void {
  registry().set(id, ctx)
}

/**
 * Odczytuje zywy kontekst Cordis zarejestrowany dla danego id. Wolane z wnetrza
 * zbundlowanej aplikacji (plugin Nitro), gdzie `id` pochodzi z wlasnego `import.meta.url`.
 */
export function getBridge(id: string): Context | undefined {
  return registry().get(id)
}

/**
 * Usuwa wpis po dispose fibera - pozwala GC zwolnic zamkniety kontekst/akumulator.
 */
export function deleteBridge(id: string): void {
  registry().delete(id)
}

/**
 * Buduje specyfikator importu niosacy id instancji oraz znacznik czasu (cache-busting
 * dla HMR: kazdy reload musi dostac NOWY specyfikator, bo Node'owy loader ESM
 * cache'uje moduly po dokladnym URL - bez tego Cordis nie zobaczylby nowego kodu).
 *
 * @param entryHref plik:// URL do zbudowanego entry (bez query)
 * @param id stabilny identyfikator instancji (np. id wpisu w konfiguracji)
 */
export function toBridgedSpecifier(entryHref: string, id: string): string {
  const url = new URL(entryHref)
  url.searchParams.set('cordis', id)
  url.searchParams.set('t', String(Date.now()))
  return url.href
}

/**
 * Odczytuje id instancji z `import.meta.url` wewnatrz zbundlowanej aplikacji.
 */
export function idFromImportMetaUrl(importMetaUrl: string): string | null {
  try {
    return new URL(importMetaUrl).searchParams.get('cordis')
  } catch {
    return null
  }
}

/**
 * Wygodny helper dla wtyczek Nitro: `getCordisContext(import.meta.url)` zwraca zywy
 * kontekst Cordis zarejestrowany przez nuxt-wrapper dla tej konkretnej instancji.
 */
export function getCordisContext(importMetaUrl: string): Context {
  const id = idFromImportMetaUrl(importMetaUrl)
  const ctx = id ? getBridge(id) : undefined
  if (!ctx) {
    throw new Error(
      `[bridge] brak zarejestrowanego kontekstu Cordis dla "${id ?? '(brak id w URL)'}". ` +
      `Ta aplikacja musi byc uruchomiona przez @shop/nuxt-wrapper, nie bezposrednio.`,
    )
  }
  return ctx
}
