import { getCordisContext } from '@shop/shared/bridge'
import type { FeatureManifestEntry } from '@shop/shared/feature-manifest'

let registered = false

/**
 * Dwie role w jednym handlerze:
 *
 * 1. Leniwa rejestracja manifestu (raz, przy PIERWSZYM requescie): kazdy
 *    modul w modules/ dopisal siebie do runtimeConfig.shopFeatures PODCZAS
 *    BUILDA (patrz module.ts w kazdym z nich) - ten manifest jest tu ladowany
 *    do koefektu 'features'. Rejestracja NIE dzieje sie w server/plugins:
 *    Nitro (preset node-listener) uruchamia pluginy SYNCHRONICZNIE podczas
 *    importu/ewaluacji modulu, ZANIM zdazy ustawic wlasny shim
 *    (`globalThis._importMeta_`), ktorego uzywa do przepisania `import.meta.url`
 *    w zbundlowanym kodzie - empirycznie zweryfikowane w tej sesji: plugin
 *    widzial pusty/nieustawiony URL i most (bridge) nigdy nie znajdowal
 *    kontekstu Cordis. Server routes/middleware (jak ten plik) wykonuja sie
 *    PO pelnej ewaluacji modulu (leniwie, per request) - dokladnie tak samo
 *    jak juz dzialajace `server/api/*.ts` w kazdym module - wiec `import.meta.url`
 *    jest tu juz poprawny. Patrz ARCHITECTURE.md#10.
 *
 *    `registered` jest ustawiane DOPIERO PO udanym `register()` - jesli ten
 *    rzuci (np. w przyszlosci dojdzie walidacja wpisow), kolejny request
 *    sprobuje ponownie zamiast trwale zablokowac rejestracje (zaobserwowane
 *    w code review tej sesji: odwrotna kolejnosc powodowala trwale,
 *    nieodwracalne "fail open" po jednym bledzie).
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
  if (!features) {
    // Nie powinno sie zdarzyc - `shop` deklaruje `inject: [..., 'features']`
    // w cordis.yml, wiec ten fiber aktywuje sie dopiero gdy koefekt jest
    // dostepny. Loguje, bo cichy fail-open (przepuszczenie requestu bez
    // gatingu) jest inaczej niewidoczny - patrz code review tej sesji.
    ctx.logger.warn('[feature-gate] koefekt "features" niedostepny - gating pominiety dla tego requestu')
    return
  }

  if (!registered) {
    const manifest = (useRuntimeConfig().shopFeatures ?? []) as FeatureManifestEntry[]
    features.register(manifest)
    registered = true
  }

  const pathname = event.path.split('?')[0]
  const id = features.resolve(pathname)
  if (id && !features.isEnabled(id)) {
    throw createError({ statusCode: 404, statusMessage: `Modul "${id}" jest obecnie wylaczony.` })
  }
})
