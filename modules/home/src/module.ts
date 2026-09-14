import { defineNuxtModule, createResolver } from '@nuxt/kit'
import { registerShopFeature } from '@shop/shared/feature-manifest'

/**
 * Warstwa "build-time module" z ARCHITECTURE.md#10: setup() wykonuje sie
 * WYLACZNIE podczas `nuxi build`/`nuxi dev` hostujacej appki (apps/shop),
 * nigdy w runtime. Rejestruje strone '/' oraz dopisuje siebie do manifestu
 * feature'ow, ktory `apps/shop/server/middleware/feature-gate.ts` odczyta
 * leniwie przy pierwszym requescie i przekaze do koefektu 'features' (NIE w
 * server/plugins - patrz ARCHITECTURE.md#plugin-import-meta-gotcha).
 */
export default defineNuxtModule({
  meta: {
    name: '@shop/module-home',
    configKey: 'shopHome',
  },
  setup(_options, nuxt) {
    const { resolve } = createResolver(import.meta.url)

    nuxt.hook('pages:extend', (pages) => {
      pages.push({
        name: 'home',
        path: '/',
        file: resolve('./runtime/pages/index.vue'),
      })
    })

    registerShopFeature(nuxt.options, { id: 'home', routes: ['/'] })
  },
})
