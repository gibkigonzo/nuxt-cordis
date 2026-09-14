import { Service, type Context } from 'cordis'
import type { FeatureManifestEntry } from '@shop/shared/feature-manifest'
// import samych deklaracji `declare module 'cordis'` z redis-service (augmentacja
// ctx.redis dla edytora/TS) - `import type` jest zawsze usuwany przez
// type-stripping, wiec brak wplywu na runtime. Realna zaleznosc runtime jest
// deklarowana przez `static inject = ['redis']` ponizej.
import type {} from '@shop/redis-service'

declare module 'cordis' {
  interface Context {
    features: FeatureRegistryService
  }
}

export type { FeatureManifestEntry }

interface FeatureRoutes {
  id: string
  routes: string[]
}

/** Redis Hash: pole = id modulu, wartosc = '1' (wlaczony) lub '0' (wylaczony). */
const ENABLED_KEY = 'shop:features:enabled'

/**
 * FeatureRegistryService: koefekt 'features'. Odpowiednik warstwy "build-time
 * manifest" + "Nitro root registry providerow" z ARCHITECTURE.md#10 - zbiór
 * MODULOW jest zamkniety w buildzie (kazdy modul Nuxta w modules/* dopisuje
 * siebie do `runtimeConfig.shopFeatures` podczas `setup()`, patrz
 * `apps/shop/server/middleware/feature-gate.ts` - rejestracja dzieje sie tam,
 * leniwie przy pierwszym requescie, NIE w server/plugins, patrz
 * ARCHITECTURE.md#plugin-import-meta-gotcha).
 *
 * Stan jest CELOWO rozdzielony na dwie czesci o roznym charakterze:
 * - `routes` (ksztalt manifestu: id -> lista sciezek) zyje LOKALNIE, w
 *   pamieci kazdego podu - jest identyczny wszedzie (ten sam obraz), wiec
 *   nie ma czego synchronizowac. Trzymanie go lokalnie utrzymuje `resolve()`
 *   (wolane przy KAZDYM requescie w feature-gate.ts) szybkim - bez zadnego
 *   zapytania sieciowego na hot path routingu.
 * - `enabled`/`disabled` zyje w Redis (koefekt 'redis') - to JEDYNA czesc
 *   stanu, ktora MUSI byc spojna miedzy wieloma podami tego samego obrazu:
 *   `disable('cart')` wywolane na jednym podzie musi natychmiast obowiazywac
 *   na WSZYSTKICH, inaczej za k8s Service (bez sticky sessions) uzytkownik
 *   widzialby losowo wlaczona/wylaczona funkcje zaleznie od tego, ktory pod
 *   akurat obsluzyl jego request - dokladnie ten problem zgloszony i
 *   naprawiony w tej sesji (patrz ARCHITECTURE.md).
 *
 * Kluczowa roznica wzgledem usunietego `@shop/remote-sync` (ARCHITECTURE.md#8):
 * tu NIC nowego nie jest importowane w runtime - `enable()`/`disable()` tylko
 * przelaczaja widocznosc kodu, ktory juz przeszedl build+review+CI i jest
 * czescia tego samego, jednego `.output`. Redis przechowuje WYLACZNIE proste
 * wartosci '0'/'1', nigdy kod.
 */
export class FeatureRegistryService extends Service {
  static inject = ['redis']

  private routes: Map<string, FeatureRoutes>

  constructor(ctx: Context) {
    super(ctx, 'features')
    this.routes = new Map()
  }

  /**
   * Zasila lokalny manifest tras (patrz docstring klasy) i seeduje domyslny
   * stan `enabled` w Redis - WYLACZNIE dla modulow, ktore jeszcze tam nie
   * istnieja (`HSETNX`). Jesli inny pod (albo poprzednie uruchomienie tego
   * samego poda) juz przelaczyl dany modul, ta rejestracja NIGDY nie
   * nadpisuje tamtego stanu. Bezpieczne do wywolania wielokrotnie (np. po
   * hot-reloadzie appki). Rzuca, jesli dwa RÓZNE moduly probuja
   * zarejestrowac dokladnie ta sama sciezke (patrz assertNoRouteCollision) -
   * odpowiednik walidacji, ktora mial usuniety `RouterService.register()`.
   */
  async register(entries: FeatureManifestEntry[]): Promise<void> {
    for (const entry of entries) {
      this.assertNoRouteCollision(entry)
      this.routes.set(entry.id, { id: entry.id, routes: entry.routes })
      await this.ctx.redis.client.hsetnx(ENABLED_KEY, entry.id, entry.enabled === false ? '0' : '1')
    }
    this.ctx.logger.info(`[features] zarejestrowano: ${entries.map((e) => e.id).join(', ') || '(brak)'}`)
  }

  async list(): Promise<Array<FeatureManifestEntry & { enabled: boolean }>> {
    const ids = [...this.routes.keys()]
    if (!ids.length) return []
    const raw = await this.ctx.redis.client.hmget(ENABLED_KEY, ...ids)
    return ids.map((id, i) => ({ ...this.routes.get(id)!, enabled: raw[i] !== '0' }))
  }

  async isEnabled(id: string): Promise<boolean> {
    if (!this.routes.has(id)) return false
    const value = await this.ctx.redis.client.hget(ENABLED_KEY, id)
    return value !== '0'
  }

  async enable(id: string): Promise<void> {
    await this.setEnabled(id, true)
  }

  async disable(id: string): Promise<void> {
    await this.setEnabled(id, false)
  }

  private async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!this.routes.has(id)) throw new Error(`[features] nieznany modul "${id}"`)
    await this.ctx.redis.client.hset(ENABLED_KEY, id, enabled ? '1' : '0')
    this.ctx.logger.info(`[features] ${id} -> ${enabled ? 'WLACZONY' : 'WYLACZONY'}`)
  }

  /**
   * Rzuca, jesli `entry` deklaruje sciezke juz zajeta przez INNY (rozny `id`)
   * juz zarejestrowany modul - dwa moduly z rozna tozsamoscia nigdy nie
   * powinny dzielic tej samej sciezki (w przeciwienstwie do wielokrotnej
   * rejestracji TEGO SAMEGO id, co jest oczekiwane przy kazdym hot-reloadzie
   * i celowo NIE jest tu flagowane). Dziala WYLACZNIE na lokalnym stanie
   * (`routes`), zero zapytan do Redis.
   */
  private assertNoRouteCollision(entry: FeatureManifestEntry): void {
    for (const [otherId, other] of this.routes) {
      if (otherId === entry.id) continue
      const collision = entry.routes.find((route) => other.routes.includes(route))
      if (collision) {
        throw new Error(
          `[features] modul "${entry.id}" probuje zarejestrowac sciezke "${collision}", ` +
          `ktora nalezy juz do modulu "${otherId}" - dwa moduly nie moga dzielic tej samej sciezki.`,
        )
      }
    }
  }

  /**
   * Dopasowanie po najdluzszym pasujacym prefiksie sciezki - zwraca id modulu
   * odpowiedzialnego za dana sciezke (niezaleznie od tego, czy jest aktualnie
   * wlaczony). `undefined` oznacza "zaden zarejestrowany modul nie deklaruje
   * tej sciezki" - taki request przechodzi dalej bez ingerencji (normalny
   * routing/404 Nuxta), patrz `apps/shop/server/middleware/feature-gate.ts`.
   * CELOWO synchroniczne i lokalne (patrz docstring klasy) - zero zapytan do
   * Redis na hot path routingu; middleware odpytuje Redis (przez isEnabled())
   * TYLKO gdy sciezka faktycznie nalezy do jakiegos modulu.
   */
  resolve(pathname: string): string | undefined {
    let best: string | undefined
    let bestLen = -1
    for (const feature of this.routes.values()) {
      for (const prefix of feature.routes) {
        const matches = pathname === prefix || pathname.startsWith(prefix + '/')
        if (matches && prefix.length > bestLen) {
          best = feature.id
          bestLen = prefix.length
        }
      }
    }
    return best
  }
}

export default FeatureRegistryService
