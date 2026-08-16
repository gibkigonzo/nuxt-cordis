#!/usr/bin/env node
// Minimalny lokalny odpowiednik pary Cloudflare KV (manifest) + R2 (artefakty),
// wylacznie do testowania @shop/remote-sync bez prawdziwego konta Cloudflare.
// W produkcji manifestUrl wskazuje na maly Cloudflare Worker odczytujacy rekord
// z KV, a artifactUrl bezposrednio na publiczny obiekt w R2 - remote-sync nie
// wie i nie musi wiedziec, ktorego z dwoch uzywasz, bo mowi wylacznie HTTP+JSON.
//
// Endpointy:
//   GET  /manifest.json                 -> { entries: [...] }
//   GET  /artifacts/:id                 -> zawartosc ostatnio opublikowanego .tar.gz
//   POST /publish?id=&version=&config=&file=   -> rejestruje/aktualizuje wpis
//   POST /unpublish?id=                 -> usuwa wpis (symuluje wycofanie modulu)

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const port = Number(process.env.MOCK_REGISTRY_PORT || 7000)
/** @type {Map<string, { version: string, config: any, filePath: string }>} */
const store = new Map()

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  if (req.method === 'GET' && url.pathname === '/manifest.json') {
    const entries = [...store.entries()].map(([id, e]) => ({
      id,
      version: e.version,
      config: e.config,
      artifactUrl: `http://localhost:${port}/artifacts/${id}`,
    }))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ entries }))
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
    const id = url.pathname.slice('/artifacts/'.length)
    const entry = store.get(id)
    if (!entry) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const buffer = await readFile(entry.filePath)
    res.setHeader('content-type', 'application/gzip')
    res.end(buffer)
    return
  }

  if (req.method === 'POST' && url.pathname === '/publish') {
    const id = url.searchParams.get('id')
    const version = url.searchParams.get('version') || String(Date.now())
    const config = JSON.parse(url.searchParams.get('config') || '{}')
    const filePath = url.searchParams.get('file')
    if (!id || !filePath) {
      res.statusCode = 400
      res.end('id i file sa wymagane')
      return
    }
    store.set(id, { version, config, filePath })
    console.log(`[mock-registry] opublikowano "${id}" @ ${version} (${filePath})`)
    res.end('ok')
    return
  }

  if (req.method === 'POST' && url.pathname === '/unpublish') {
    const id = url.searchParams.get('id')
    if (id) store.delete(id)
    console.log(`[mock-registry] wycofano "${id}"`)
    res.end('ok')
    return
  }

  res.statusCode = 404
  res.end('not found')
})

server.listen(port, () => {
  console.log(`[mock-registry] nasluchuje na http://localhost:${port}`)
})
