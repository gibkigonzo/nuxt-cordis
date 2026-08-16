#!/usr/bin/env node
// Pakuje zbudowany katalog `.output` danej aplikacji (apps/<id>) w archiwum
// .tar.gz, gotowe do wrzucenia na Cloudflare R2 (patrz deploy/workflows/deploy-module.yml)
// lub do lokalnego mock-registry (deploy/scripts/mock-registry-server.mjs).
//
// Uzycie: node deploy/scripts/publish-module.mjs <id> [outDir]
//   <id>     - nazwa katalogu w apps/ (np. "checkout")
//   [outDir] - katalog docelowy na archiwum (domyslnie ./deploy/.artifacts)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..', '..')

const [, , id, outDirArg] = process.argv
if (!id) {
  console.error('Uzycie: node deploy/scripts/publish-module.mjs <id> [outDir]')
  process.exit(1)
}

const appDir = join(projectRoot, 'apps', id)
const outputDir = join(appDir, '.output')
const outDir = outDirArg ? resolve(outDirArg) : join(projectRoot, 'deploy', '.artifacts')

try {
  await access(outputDir)
} catch {
  console.error(`Brak ${outputDir} - zbuduj najpierw: pnpm --filter ${id} run build`)
  process.exit(1)
}

await mkdir(outDir, { recursive: true })
const version = process.env.MODULE_VERSION || new Date().toISOString()
const safeVersion = version.replace(/[^a-z0-9.-]/gi, '_')
const archivePath = join(outDir, `${id}-${safeVersion}.tar.gz`)

// Archiwum zachowuje sam folder ".output" (pakowane z appDir, nie z jego wnetrza) -
// po rozpakowaniu przez remote-sync do <cacheDir>/<id>/ powstaje struktura
// <cacheDir>/<id>/.output/server/index.mjs, DOKLADNIE taka, jakiej domyslnie
// oczekuje @shop/nuxt-wrapper (config.dir + domyslne config.entry). Dzieki temu
// ten sam config dziala identycznie dla aplikacji lokalnej (apps/<id>) i
// pobranej zdalnie (.remote-cache/<id>) - zero specjalnych przypadkow.
await execFileAsync('tar', ['-czf', archivePath, '-C', appDir, '.output'])

console.log(`OK: ${archivePath}`)
console.log(`id=${id} version=${version}`)
