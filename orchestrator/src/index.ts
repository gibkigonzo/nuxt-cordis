import { Context } from 'cordis'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import Loader from '@cordisjs/plugin-loader'

// Baza sciezek liczona wzgledem WLASNEJ lokalizacji tego pliku (a nie process.cwd()),
// zeby dzialac identycznie niezaleznie od tego, skad zostal uruchomiony proces
// (`node orchestrator/src/index.ts` z korzenia repo, `pnpm --filter orchestrator start`
// z wlasnym cwd, kontener Docker z innym WORKDIR, itd).
const here = dirname(fileURLToPath(import.meta.url)) // .../orchestrator/src
const projectRoot = join(here, '..', '..')

const ctx = new Context()
ctx.baseUrl = pathToFileURL(projectRoot + '/').href

// CORDIS_CONFIG pozwala wskazac alternatywny plik (np. cordis.dev.yml z
// config.watch: true dla lokalnego developmentu - patrz README/DEPLOYMENT.md).
// Domyslnie: konfiguracja "produkcyjna" bez watcherow systemu plikow, zgodna z
// modelem z deploy.md (przeladowania wyzwalane zmiana deklaratywnego configu).
const configPath = process.env.CORDIS_CONFIG ?? './cordis.yml'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: {
    // Cala kompozycja systemu (uslugi, brama, instancje Nuxt) jest deklarowana
    // tutaj, nie w tym pliku.
    path: configPath,
  },
})

console.log(`[orchestrator] wystartowal, konfiguracja: ${projectRoot}/${configPath.replace(/^\.\//, '')}`)

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[orchestrator] otrzymano ${signal}, zamykam wszystkie fibery (LIFO)...`)

  const forceExit = setTimeout(() => {
    console.error('[orchestrator] zamykanie przekroczylo limit czasu (10s) - wymuszam wyjscie')
    process.exit(1)
  }, 10_000)
  forceExit.unref()

  try {
    // Dispose fibera glownego kontekstu kaskadowo cofa efekty calego drzewa
    // komponentow (Corollary 62/Theorem 66: gwarantowane osiagniecie stanu
    // spoczynkowego), w tym zamkniecie kazdego http.Server przez @shop/nuxt-wrapper.
    await ctx.fiber.dispose()
  } catch (error) {
    console.error('[orchestrator] blad podczas zamykania:', error)
  } finally {
    clearTimeout(forceExit)
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
