// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  srcDir: '.',
  devtools: { enabled: false },
  telemetry: false,

  app: {
    baseURL: '/cart/',
    head: {
      title: 'Sklep Cordis - Koszyk',
    },
  },

  devServer: {
    port: 3002,
  },

  nitro: {
    preset: 'node-listener',
  },
})
