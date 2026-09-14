export interface FeatureManifestEntry {
  /** stabilny identyfikator modulu (np. 'product') */
  id: string
  /**
   * Wszystkie prefiksy sciezek nalezace do tego modulu - strona ORAZ kazdy
   * jej wlasny server route (addServerHandler). Pominiecie ktoregokolwiek
   * z nich oznacza, ze `disable(id)` nie zablokuje danej sciezki - patrz
   * ARCHITECTURE.md#feature-registry.
   */
  routes: string[]
  /** stan poczatkowy, domyslnie true */
  enabled?: boolean
}

/**
 * Wspolny helper dla `module.ts` w kazdym katalogu `modules/*`: dopisuje wpis do manifestu
 * feature'ow, ktory `apps/shop/server/middleware/feature-gate.ts` odczyta
 * leniwie przy pierwszym requescie (patrz ARCHITECTURE.md#10). Przyjmuje
 * `nuxt.options` (nie caly obiekt `Nuxt`), zeby nie dodawac zaleznosci na
 * `@nuxt/schema` wylacznie dla typu parametru.
 */
export function registerShopFeature(
  nuxtOptions: { runtimeConfig: Record<string, unknown> },
  entry: FeatureManifestEntry,
): void {
  const shopFeatures = (nuxtOptions.runtimeConfig.shopFeatures ??= []) as FeatureManifestEntry[]
  shopFeatures.push(entry)
}
