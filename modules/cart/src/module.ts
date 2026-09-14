import { defineNuxtModule, createResolver, addServerHandler } from '@nuxt/kit'
import { registerShopFeature } from '@shop/shared/feature-manifest'

export interface ModuleOptions {
  routePrefix?: string
}

/**
 * Patrz modules/home/src/module.ts i modules/product/src/module.ts po ogolny
 * opis warstwy oraz po wyjasnienie, dlaczego manifest musi objac API, nie
 * tylko strone. `/api/cart` w `routes` ponizej pokrywa (przez dopasowanie
 * prefiksowe w FeatureRegistryService.resolve()) wszystkie trzy server routes
 * ponizej (/api/cart, /api/cart/remove, /api/cart/clear) - NIE koliduje z
 * `/api/cart/add` z modules/product, bo ta sciezka jest dluzszym, bardziej
 * specyficznym prefiksem i zawsze wygrywa dopasowanie.
 */
export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@shop/module-cart',
    configKey: 'shopCart',
  },
  defaults: {
    routePrefix: '/cart',
  },
  setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const prefix = options.routePrefix ?? '/cart'

    nuxt.hook('pages:extend', (pages) => {
      pages.push({
        name: 'cart',
        path: prefix,
        file: resolve('./runtime/pages/index.vue'),
      })
    })

    addServerHandler({ route: '/api/cart', method: 'get', handler: resolve('./runtime/server/api/cart.get.ts') })
    addServerHandler({ route: '/api/cart/remove', method: 'post', handler: resolve('./runtime/server/api/cart/remove.post.ts') })
    addServerHandler({ route: '/api/cart/clear', method: 'post', handler: resolve('./runtime/server/api/cart/clear.post.ts') })

    registerShopFeature(nuxt.options, { id: 'cart', routes: [prefix, '/api/cart'] })
  },
})
