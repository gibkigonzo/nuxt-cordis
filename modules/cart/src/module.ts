import { defineNuxtModule, createResolver, addServerHandler } from '@nuxt/kit'

export interface ModuleOptions {
  routePrefix?: string
}

/** Patrz modules/home/src/module.ts i modules/product/src/module.ts po ogolny opis. */
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

    const shopFeatures = ((nuxt.options.runtimeConfig.shopFeatures ??= []) as unknown[])
    shopFeatures.push({ id: 'cart', routes: [prefix] })
  },
})
