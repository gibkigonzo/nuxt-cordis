import type { Context } from 'cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export interface RemoteEntry {
  /** stabilny identyfikator wpisu (id w cordis.yml) */
  id: string
  /** URL do archiwum .tar.gz z zawartoscia katalogu ".output" zbudowanej aplikacji */
  artifactUrl: string
  /** dowolny znacznik wersji (hash commita, timestamp) - zmiana wyzwala reload */
  version: string
  /** config przekazywany do @shop/nuxt-wrapper (id/port/inject/route sa uzupelniane automatycznie) */
  config: Record<string, unknown>
}

export interface RemoteManifest {
  entries: RemoteEntry[]
}

export interface RemoteSyncConfig {
  /** URL zwracajacy JSON zgodny z RemoteManifest (np. Cloudflare KV przez Worker, lub zwykly R2/HTTP endpoint) */
  manifestUrl: string
  /** co ile ms odpytywac manifest (domyslnie 15s) */
  pollInterval?: number
  /** katalog na rozpakowane artefakty, wzgledem baseUrl orchestratora (domyslnie .remote-cache) */
  cacheDir?: string
}

export const name = 'remote-sync'

/**
 * Reconciler deklaratywnej konfiguracji pobieranej zdalnie (Section 3 z deploy.md).
 * Zamiast czytac lokalny cordis.yml, ten komponent okresowo odpytuje `manifestUrl`
 * i dla kazdego wpisu, ktorego `version` sie zmienil, sciaga zbudowany artefakt
 * (.tar.gz z zawartoscia ".output") i wola `ctx.loader.create/update/remove` -
 * dokladnie ten sam mechanizm dynamicznej kompozycji, ktorego uzywa lokalny
 * cordis.yml, tylko zasilany zdalnym zrodlem prawdy zamiast pliku na dysku.
 *
 * W deploy.md manifestUrl wskazuje na Cloudflare KV (przez maly Worker odczytujacy
 * rekord), a artifactUrl na Cloudflare R2 - ale mechanizm jest calkowicie
 * niezalezny od dostawcy: dziala z dowolnym serwerem HTTP zwracajacym JSON +
 * archiwa .tar.gz (patrz deploy/scripts/mock-registry-server.mjs, ktory
 * symuluje dokladnie taka pare endpointow do testow lokalnych).
 */
export function apply(ctx: Context, config: RemoteSyncConfig): void {
  const cacheDirName = config.cacheDir ?? '.remote-cache'
  const interval = config.pollInterval ?? 15_000
  const seenVersions = new Map<string, string>()

  ctx.effect(() => {
    let stopped = false
    let inFlight: Promise<void> | null = null

    const tick = () => {
      if (stopped || inFlight) return
      inFlight = sync().catch((error) => {
        ctx.logger.warn(`[remote-sync] blad synchronizacji: ${(error as Error).message}`)
      }).finally(() => {
        inFlight = null
      })
    }

    tick()
    const timer = setInterval(tick, interval)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'remote-sync:poll')

  async function sync(): Promise<void> {
    const manifest = await fetch(config.manifestUrl).then((r) => {
      if (!r.ok) throw new Error(`manifest ${config.manifestUrl} -> HTTP ${r.status}`)
      return r.json() as Promise<RemoteManifest>
    })

    const seenIds = new Set(manifest.entries.map((e) => e.id))

    // Usuniecie wpisow, ktore zniknely z manifestu (analog O-Retire + O-Remove,
    // Section 4.2) - fiber jest bezpiecznie cofniety (dispose), zanim wpis
    // konfiguracji zniknie.
    for (const id of [...seenVersions.keys()]) {
      if (!seenIds.has(id)) {
        await removeEntry(ctx, id)
        seenVersions.delete(id)
      }
    }

    for (const entry of manifest.entries) {
      if (seenVersions.get(entry.id) === entry.version) continue

      const dir = await downloadAndExtract(ctx, entry, cacheDirName)
      const entryOptions = {
        id: entry.id,
        name: '@shop/nuxt-wrapper',
        config: { ...entry.config, id: entry.id, dir },
      }

      const existed = entryExists(ctx, entry.id)
      if (existed) {
        await ctx.loader.update(entry.id, entryOptions)
        ctx.logger.info(`[remote-sync] zaktualizowano modul "${entry.id}" -> wersja ${entry.version}`)
      } else {
        await ctx.loader.create(entryOptions)
        ctx.logger.info(`[remote-sync] dodano nowy modul "${entry.id}" (wersja ${entry.version}) - bez restartu procesu`)
      }
      seenVersions.set(entry.id, entry.version)
    }
  }
}

function entryExists(ctx: Context, id: string): boolean {
  try {
    ctx.loader.resolve(id)
    return true
  } catch {
    return false
  }
}

async function removeEntry(ctx: Context, id: string): Promise<void> {
  if (!entryExists(ctx, id)) return
  ctx.loader.remove(id)
  ctx.logger.info(`[remote-sync] usunieto modul "${id}" (zniknal z manifestu)`)
}

async function downloadAndExtract(ctx: Context, entry: RemoteEntry, cacheDirName: string): Promise<string> {
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  const cacheRoot = isAbsolute(cacheDirName) ? cacheDirName : resolve(base, cacheDirName)
  const targetDir = join(cacheRoot, entry.id)
  const tarPath = join(cacheRoot, `${entry.id}.${entry.version.replace(/[^a-z0-9.-]/gi, '_')}.tar.gz`)

  await mkdir(cacheRoot, { recursive: true })
  const res = await fetch(entry.artifactUrl)
  if (!res.ok) throw new Error(`artifact ${entry.artifactUrl} -> HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  await writeFile(tarPath, buffer)

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  await execFileAsync('tar', ['-xzf', tarPath, '-C', targetDir])
  await rm(tarPath, { force: true })

  return targetDir
}

export default { name, apply }
