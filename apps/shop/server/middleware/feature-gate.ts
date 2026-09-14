import { getCordisContext } from '@shop/shared/bridge'

let registered = false

/**
 * Dwie role w jednym handlerze:
 *
 * 1. Leniwa rejestracja manifestu (raz, przy PIERWSZYM requescie): kazdy
 *    modul w modules/ dopisal siebie do runtimeConfig.shopFeatures PODCZAS
 *    BUILDA (patrz module.ts w kazdym z nich) - ten manifest jest tu ladowany
 *    do koefektu 'features'. Rejestracja NIE dzieje sie w server/plugins:
 *    Nitro (preset node-listener) uruchamia pluginy SYNCHRONICZNIE podczas
 *    importu/ewaluacji modulu, ZANIM zdazy ustawic wlasny wewnetrzny shim
 *    (`globalThis._importMeta_`), ktorego uzywa do przepisania `import.meta.url`
 *    w zbundlowanym kodzie - empirycznie zweryfikowane w tej sesji: plugin
 *    widzial pusty/nieustawiony URL i most (bridge) nigdy nie znajdowal
 *    kontekstu Cordis. Server routes/middleware (jak ten plik) wykonuja sie
 *    PO pelnej ewaluacji modulu (leniwie, per request) - dokladnie tak samo
 *    jak juz dzialajace `server/api/*.ts` w kazdym module - wiec `import.meta.url`
 *    jest tu juz poprawny. Patrz ARCHITECTURE.md#10.
 *
 * 2. Bramkowanie: czy modul odpowiedzialny za ta sciezke jest aktualnie
 *    wlaczony? Wylaczenie modulu NIE usuwa jego kodu z buildu (jest juz
 *    zbundlowany w .output razem z reszta apps/shop) - tylko chwilowo
 *    blokuje do niego dostep, BEZ rebuildu i BEZ restartu procesu. To jest
 *    "skladanie funkcjonalnosci w trakcie zycia frontendu" bez ladowania
 *    niezweryfikowanego kodu (odwrotnie niz usuniety @shop/remote-sync,
 *    ARCHITECTURE.md#8): zbior MOZLIWYCH modulow jest zamkniety w buildzie,
 *    runtime decyduje tylko, KTORE z nich sa aktywne.
 */
export default defineEventHandler((event) => {
  const ctx = getCordisContext(import.meta.url)
  const features = ctx.get('features')
  if (!features) return

  if (!registered) {
    registered = true
    const manifest = (useRuntimeConfig().shopFeatures ?? []) as Array<{ id: string; routes: string[] }>
    features.register(manifest)
  }

  const pathname = event.path.split('?')[0] ?? event.path
  const id = features.resolve(pathname)
  if (id && !features.isEnabled(id)) {
    throw createError({ statusCode: 404, statusMessage: `Modul "${id}" jest obecnie wylaczony.` })
  }
})
