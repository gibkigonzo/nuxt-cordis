// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  srcDir: '.',
  devtools: { enabled: false },
  telemetry: false,

  app: {
    // Aplikacja jest publicznie wystawiona przez brokera pod /product - baseURL
    // musi sie z tym zgadzac, zeby linki/assety generowane po stronie klienta
    // wskazywaly z powrotem na wlasciwy prefiks (broker odcina go przed forward'em).
    baseURL: '/product/',
    head: {
      title: 'Sklep Cordis - Katalog',
    },
  },

  devServer: {
    port: 3001,
  },

  nitro: {
    preset: 'node-listener',
  },
})
