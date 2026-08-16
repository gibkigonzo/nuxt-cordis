// Minimalny Cloudflare Worker: skleja wszystkie klucze "entry:*" z KV Namespace
// w jeden JSON `{ entries: [...] }` pod GET /manifest.json - dokladnie w
// formacie, ktorego oczekuje @shop/remote-sync (RemoteManifest).
//
// Pipeline (deploy/workflows/deploy-module.yml) zapisuje po jednym kluczu
// "entry:<id>" per modul; ten Worker jest jedynym miejscem, ktore sklada je
// w calosc - dzieki czemu wiele rownoleglych jobow CI (jeden na kazdy zmieniony
// modul) moze pisac do KV bez wzajemnej kolizji (kazdy pisze pod WLASNY klucz).
//
// Deploy: `wrangler deploy` z tego katalogu (po skonfigurowaniu wrangler.toml
// z prawdziwym KV namespace id - patrz deploy/README.md).

export interface Env {
  MANIFEST_KV: KVNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method !== 'GET' || url.pathname !== '/manifest.json') {
      return new Response('not found', { status: 404 })
    }

    const list = await env.MANIFEST_KV.list({ prefix: 'entry:' })
    const entries = await Promise.all(
      list.keys.map(async (key) => {
        const raw = await env.MANIFEST_KV.get(key.name)
        return raw ? JSON.parse(raw) : null
      }),
    )

    return new Response(JSON.stringify({ entries: entries.filter(Boolean) }), {
      headers: {
        'content-type': 'application/json',
        // Krotki cache - remote-sync i tak odpytuje co kilka/kilkanascie
        // sekund (config.pollInterval), agresywne cache'owanie tylko
        // zwiekszaloby opoznienie propagacji zmian bez realnej korzysci.
        'cache-control': 'public, max-age=5',
      },
    })
  },
}
