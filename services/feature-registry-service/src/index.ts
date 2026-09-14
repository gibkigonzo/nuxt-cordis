import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    features: FeatureRegistryService
  }
}

export interface FeatureManifestEntry {
  /** stabilny identyfikator modulu (np. 'product') */
  id: string
  /** prefiksy stron nalezace do tego modulu (np. ['/product']) - patrz resolve() */
  routes: string[]
  /** stan poczatkowy, domyslnie true */
  enabled?: boolean
}

interface FeatureState extends FeatureManifestEntry {
  enabled: boolean
}

/**
 * FeatureRegistryService: koefekt 'features'. Odpowiednik warstwy "build-time
 * manifest" + "Nitro root registry providerow" z ARCHITECTURE.md#10 - zbiór
 * MODULOW jest zamkniety w buildzie (kazdy modul Nuxta w `modules/*` dopisuje
 * siebie do `runtimeConfig.shopFeatures` podczas `setup()`, patrz
 * `apps/shop/server/plugins/cordis.ts`), ale to, KTORE z nich sa aktywne,
 * jest reaktywnym stanem w pamieci procesu - da sie przelaczac bez rebuildu
 * i bez restartu, dokladnie tak jak `RouterService` przelaczal trasy.
 *
 * Kluczowa roznica wzgledem usunietego `@shop/remote-sync` (ARCHITECTURE.md#8):
 * tu NIC nowego nie jest importowane w runtime - `enable()`/`disable()` tylko
 * przelaczaja widocznosc kodu, ktory juz przeszedl build+review+CI i jest
 * czescia tego samego, jednego `.output`.
 */
export class FeatureRegistryService extends Service {
  private features: Map<string, FeatureState>

  constructor(ctx: Context) {
    super(ctx, 'features')
    this.features = new Map()
  }

  /**
   * Zasila rejestr manifestem wygenerowanym przez modul(y) Nuxta podczas builda
   * (patrz `nuxt.options.runtimeConfig.shopFeatures` w kazdym `modules/*`).
   * Bezpieczne do wywolania wielokrotnie (np. po make-before-break podmianie
   * appki) - istniejacy stan `enabled` jest zachowany, nowe wpisy dostaja
   * wartosc domyslna.
   */
  register(entries: FeatureManifestEntry[]): void {
    for (const entry of entries) {
      const existing = this.features.get(entry.id)
      this.features.set(entry.id, {
        ...entry,
        enabled: existing?.enabled ?? entry.enabled ?? true,
      })
    }
    this.ctx.logger.info(`[features] zarejestrowano: ${entries.map((e) => e.id).join(', ') || '(brak)'}`)
  }

  list(): FeatureState[] {
    return [...this.features.values()]
  }

  isEnabled(id: string): boolean {
    return this.features.get(id)?.enabled ?? false
  }

  enable(id: string): void {
    this.setEnabled(id, true)
  }

  disable(id: string): void {
    this.setEnabled(id, false)
  }

  private setEnabled(id: string, enabled: boolean): void {
    const feature = this.features.get(id)
    if (!feature) throw new Error(`[features] nieznany modul "${id}"`)
    feature.enabled = enabled
    this.ctx.logger.info(`[features] ${id} -> ${enabled ? 'WLACZONY' : 'WYLACZONY'}`)
  }

  /**
   * Dopasowanie po najdluzszym pasujacym prefiksie sciezki - zwraca id modulu
   * odpowiedzialnego za dana sciezke (niezaleznie od tego, czy jest aktualnie
   * wlaczony). `undefined` oznacza "zaden zarejestrowany modul nie deklaruje
   * tej sciezki" - taki request przechodzi dalej bez ingerencji (normalny
   * routing/404 Nuxta), patrz `apps/shop/server/middleware/feature-gate.ts`.
   */
  resolve(pathname: string): string | undefined {
    let best: string | undefined
    let bestLen = -1
    for (const feature of this.features.values()) {
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
