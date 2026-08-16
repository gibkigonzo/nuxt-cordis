// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  // Klasyczny plaski uklad katalogow (pages/ w korzeniu), niezaleznie od domyslnego
  // ukladu app/ wprowadzonego w Nuxt 4.
  srcDir: '.',
  devtools: { enabled: false },
  telemetry: false,

  app: {
    baseURL: '/',
    head: {
      title: 'Sklep Cordis - Strona glowna',
    },
  },

  devServer: {
    port: 3000,
  },

  nitro: {
    // Preset embedowalny: budowany plik eksportuje goly `listener` (bez wlasnego
    // http.Server ani obslugi sygnalow procesu) - to jego wraca opakowuje
    // @shop/nuxt-wrapper w rewersyjny efekt Cordis (ctx.effect + server.close()).
    preset: 'node-listener',
  },
})
