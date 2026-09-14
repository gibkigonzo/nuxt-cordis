import { getCordisContext } from '@shop/shared/bridge'
import type { FeatureManifestEntry } from '@shop/shared/feature-manifest'

/**
 * Promise w toku (nie bool) - `register()` jest teraz asynchroniczne (pisze do
 * Redis, patrz services/feature-registry-service), wiec kilka requestow moze
 * dotrzec tu RÓWNOCZESNIE zanim pierwsza rejestracja sie zakonczy. Memoizacja
 * na SAMYM PROMISIE (nie na osobnej fladze ustawianej po fakcie) gwarantuje,
 * ze wszystkie takie requesty czekaja na TA SAMA, jedna rejestracje, zamiast
 * wyscigu kilku rownoleglych `register()`. Resetowana na `undefined` przy
 * bledzie, zeby KOLEJNY request sprobowal ponownie zamiast trwale utknac w
 * stanie "fail open" (zaobserwowane w code review tej sesji dla wczesniejszej,
 * boolowej wersji tej flagi).
 */
let registration: Promise<void> | undefined

/**
 * Dwie role w jednym handlerze:
 *
 * 1. Leniwa rejestracja manifestu (raz PER POD, przy PIERWSZYM requescie,
 *    ktory ten pod obsluzy): kazdy modul w modules/ dopisal siebie do
 *    runtimeConfig.shopFeatures PODCZAS BUILDA (patrz module.ts w kazdym z
 *    nich) - ten manifest jest tu ladowany do koefektu 'features'.
 *    Rejestracja NIE dzieje sie w server/plugins: Nitro (preset node-listener)
 *    uruchamia pluginy SYNCHRONICZNIE podczas importu/ewaluacji modulu,
 *    ZANIM zdazy ustawic wlasny shim (`globalThis._importMeta_`), ktorego
 *    uzywa do przepisania `import.meta.url` w zbundlowanym kodzie -
 *    empirycznie zweryfikowane w tej sesji: plugin widzial pusty/nieustawiony
 *    URL i most (bridge) nigdy nie znajdowal kontekstu Cordis. Server
 *    routes/middleware (jak ten plik) wykonuja sie PO pelnej ewaluacji modulu
 *    (leniwie, per request) - dokladnie tak samo jak juz dzialajace
 *    `server/api/*.ts` w kazdym module - wiec `import.meta.url` jest tu juz
 *    poprawny. Patrz ARCHITECTURE.md#10.
 *
 * 2. Bramkowanie: czy modul odpowiedzialny za ta sciezke jest aktualnie
 *    wlaczony? Wylaczenie modulu NIE usuwa jego kodu z buildu (jest juz
 *    zbundlowany w .output razem z reszta apps/shop) - tylko chwilowo
 *    blokuje do niego dostep, BEZ rebuildu i BEZ restartu procesu, i (dzieki
 *    temu, ze `isEnabled()` czyta z Redis, patrz services/feature-registry-service)
 *    SPOJNIE na WSZYSTKICH podach naraz, nie tylko na tym, ktory obsluzyl
 *    wywolanie `disable()`. To jest "skladanie funkcjonalnosci w trakcie
 *    zycia frontendu" bez ladowania niezweryfikowanego kodu (odwrotnie niz
 *    usuniety @shop/remote-sync, ARCHITECTURE.md#8): zbior MOZLIWYCH modulow
 *    jest zamkniety w buildzie, runtime decyduje tylko, KTORE z nich sa
 *    aktywne - a Redis przechowuje WYLACZNIE te decyzje ('0'/'1'), nigdy kod.
 */
export default defineEventHandler(async (event) => {
  // `/healthz` (patrz server/api/healthz.get.ts) musi dzialac NIEZALEZNIE od
  // Redis/koefektow Cordis - to jedyny endpoint, ktory livenessProbe odpytuje
  // wlasnie DLATEGO, ze `/` (readinessProbe) wymaga sprawnego Redisa nizej.
  if (event.path.split('?')[0] === '/healthz') return

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

  registration ??= features
    .register((useRuntimeConfig().shopFeatures ?? []) as FeatureManifestEntry[])
    .catch((error) => {
      registration = undefined
      throw error
    })
  await registration

  const pathname = event.path.split('?')[0]
  const id = features.resolve(pathname)
  if (id && !(await features.isEnabled(id))) {
    throw createError({ statusCode: 404, statusMessage: `Modul "${id}" jest obecnie wylaczony.` })
  }
})
