// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  // Klasyczny plaski uklad katalogow (pages/ w korzeniu), niezaleznie od domyslnego
  // ukladu app/ wprowadzonego w Nuxt 4. apps/shop samo NIE ma wlasnego katalogu
  // pages/ - kazda strona pochodzi z modulu (modules/*), patrz ARCHITECTURE.md#10.
  srcDir: '.',
  devtools: { enabled: false },
  telemetry: false,
  css: ['~/assets/main.css'],

  // Kazdy modul rejestruje wlasna(e) strone(y) i server routes podczas setup()
  // (build-time, patrz modules/*/src/module.ts) - ich kolejnosc tu NIE ma
  // znaczenia funkcjonalnego (kazdy rejestruje wlasny, rozlaczny prefiks tras).
  modules: [
    '@shop/module-home',
    '@shop/module-product',
    '@shop/module-cart',
  ],

  app: {
    baseURL: '/',
    head: {
      title: 'Sklep Cordis',
    },
  },

  devServer: {
    port: 8080,
  },

  nitro: {
    // Preset embedowalny: budowany plik eksportuje goly `listener` (bez wlasnego
    // http.Server ani obslugi sygnalow procesu) - to jego wraca opakowuje
    // @shop/nuxt-wrapper w rewersyjny efekt Cordis (ctx.effect + server.close()).
    preset: 'node-listener',
  },
})
