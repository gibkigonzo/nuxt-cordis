import { defineNuxtModule, createResolver } from '@nuxt/kit'

/**
 * Warstwa "build-time module" z ARCHITECTURE.md#10: setup() wykonuje sie
 * WYLACZNIE podczas `nuxi build`/`nuxi dev` hostujacej appki (apps/shop),
 * nigdy w runtime. Rejestruje strone '/' oraz dopisuje siebie do
 * `runtimeConfig.shopFeatures` - manifestu, ktory `apps/shop/server/plugins/cordis.ts`
 * odczyta raz przy starcie Nitro i przekaze do koefektu 'features'.
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

    const shopFeatures = ((nuxt.options.runtimeConfig.shopFeatures ??= []) as unknown[])
    shopFeatures.push({ id: 'home', routes: ['/'] })
  },
})
