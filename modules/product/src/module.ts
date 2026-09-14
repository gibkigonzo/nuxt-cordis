import { defineNuxtModule, createResolver, addServerHandler } from '@nuxt/kit'
import { registerShopFeature } from '@shop/shared/feature-manifest'

export interface ModuleOptions {
  routePrefix?: string
}

/**
 * Patrz modules/home/src/module.ts po ogolny opis warstwy. Ten modul dodatkowo
 * rejestruje dwa server routes (addServerHandler) - dokladnie te same pliki,
 * ktore wczesniej zyly w apps/product/server/api/*, przeniesione bez zmian
 * logiki. Publiczne sciezki API SWIADOMIE zostaja bez prefiksu modulu
 * (/api/catalog, /api/cart/add) - to wciaz ten sam, jeden zasob "koszyk",
 * ktory modules/cart tez obsluguje, teraz bez brokera prefiksujacego trasy.
 *
 * Manifest (`routes`) deklaruje strone ORAZ obie sciezki API - pominiecie
 * ktorejkolwiek oznaczaloby, ze `disable('product')` chowa strone, ale
 * zostawia API w pelni dzialajace (zgloszone i naprawione w tej sesji, patrz
 * ARCHITECTURE.md#feature-registry).
 */
export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@shop/module-product',
    configKey: 'shopProduct',
  },
  defaults: {
    routePrefix: '/product',
  },
  setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const prefix = options.routePrefix ?? '/product'

    nuxt.hook('pages:extend', (pages) => {
      pages.push({
        name: 'product',
        path: prefix,
        file: resolve('./runtime/pages/index.vue'),
      })
    })

    addServerHandler({ route: '/api/catalog', method: 'get', handler: resolve('./runtime/server/api/catalog.get.ts') })
    addServerHandler({ route: '/api/cart/add', method: 'post', handler: resolve('./runtime/server/api/cart/add.post.ts') })

    registerShopFeature(nuxt.options, { id: 'product', routes: [prefix, '/api/catalog', '/api/cart/add'] })
  },
})
