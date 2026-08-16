# Deployment

Dwie sciezki, opisane w `PlAn.md`/`deploy.md`. Status weryfikacji kazdej -
patrz `../README.md#status-weryfikacji`.

## Docker (self-hosted) {#docker}

Jeden kontener = caly system (jeden proces Node, jeden publiczny port: 8080).
Zweryfikowane w tym repo: `docker build`, `docker run`, ruch HTTP przez
brokera do wszystkich trzech aplikacji, wspoldzielony stan koszyka miedzy
nimi, oraz `docker stop` (graceful shutdown, ~160ms).

```sh
docker build -f deploy/docker/Dockerfile -t nuxt-cordis-shop:latest .
docker run -d -p 8080:8080 --name shop nuxt-cordis-shop:latest

curl http://localhost:8080/
curl http://localhost:8080/product/api/catalog

docker stop shop   # SIGTERM -> ctx.fiber.dispose() -> LIFO cleanup
```

lub przez compose:

```sh
docker compose -f deploy/docker/docker-compose.yml up --build
```

**Aktualizacja jednej aplikacji w tym modelu = rebuild calego obrazu** (bo
obraz jest niezmiennym artefaktem calego systemu). Jesli potrzebujesz
aktualizowac pojedyncze moduly bez rebuildu calego obrazu/kontenera, patrz
sekcja ponizej (Cloudflare R2/KV) - to jest DOKLADNIE problem, ktory ten
model rozwiazuje.

## Cloudflare R2/KV + GitHub Actions (`deploy.md`) {#cloudflare}

Realizuje dokladnie flow z `deploy.md`: pipeline buduje TYLKO zmieniony
modul, publikuje go jako artefakt pod URL-em (R2), aktualizuje "source of
truth" configu (KV przez maly Worker), a dzialajacy orchestrator sam
wykrywa zmiane i doklada/aktualizuje/usuwa modul **bez restartu procesu**.

WAZNE (patrz `../ARCHITECTURE.md#cloudflare-workers` po pelne wyjasnienie):
sam orchestrator **nie dziala na Cloudflare Workers** (techniczne
ograniczenia: brak `node:http`, brak systemu plikow, brak dynamicznego
`import()` dowolnego URL). Dziala na zwyklym, dlugozyjacym hoscie Node (VM,
Docker na dowolnym providerze, Fly.io, Render, DigitalOcean App Platform...).
Cloudflare dostarcza WYLACZNIE: storage artefaktow (R2) i "source of truth"
configu (KV + Worker).

### Komponenty

| Komponent | Gdzie | Co robi |
|---|---|---|
| `deploy/workflows/deploy-module.yml` | GitHub Actions | wykrywa zmieniony `apps/<id>`, buduje TYLKO go, pakuje `.output` w `.tar.gz`, wrzuca na R2, zapisuje wpis w KV |
| `deploy/cloudflare/manifest-worker` | Cloudflare Worker | skleja wpisy KV w `GET /manifest.json` |
| `packages/remote-sync` | proces orchestratora (Node) | odpytuje `/manifest.json`, pobiera zmienione artefakty, woła `ctx.loader.create/update/remove` |

### Konfiguracja (jednorazowa)

1. **R2**: `wrangler r2 bucket create <nazwa>` - ustaw `vars.R2_BUCKET` w
   ustawieniach repo GitHub oraz publiczny URL bucketu jako `vars.R2_PUBLIC_BASE_URL`
   (Public Development URL lub wlasna domena podpieta pod bucket).
2. **KV**: `wrangler kv namespace create MANIFEST_KV` - id namespace wpisz w
   `deploy/cloudflare/manifest-worker/wrangler.toml` (`[[kv_namespaces]] id = ...`)
   oraz jako `vars.KV_NAMESPACE_ID` w ustawieniach repo GitHub.
3. **Worker**: `cd deploy/cloudflare/manifest-worker && pnpm install && pnpm run deploy`
   - zanotuj publiczny URL Workera (np. `https://nuxt-cordis-manifest.<konto>.workers.dev`).
4. **Sekrety GitHub Actions**: `CLOUDFLARE_API_TOKEN` (token z uprawnieniami
   Workers KV Storage: Edit + Workers R2 Storage: Edit), `CLOUDFLARE_ACCOUNT_ID`.
5. **Config per modul**: `vars.MODULE_CONFIG_<id>` (JSON, np. dla `checkout`:
   `{"port":3003,"inject":["cart","router"],"route":"/checkout"}`) - patrz
   `deploy/checkout-module-plan.md` po przyklad.
6. Skopiuj `deploy/workflows/deploy-module.yml` do `.github/workflows/` w
   repo (trzymany poza `.github/` celowo, jako szablon do przejrzenia przed
   aktywacja - patrz komentarz na gorze pliku).

### Uruchomienie orchestratora z reconcilerem zdalnej konfiguracji

Dopisz do configu orchestratora (obok lub zamiast lokalnych wpisow z
`cordis.yml`) wpis:

```yaml
- id: remote-sync
  name: '@shop/remote-sync'
  config:
    manifestUrl: https://nuxt-cordis-manifest.<konto>.workers.dev/manifest.json
    pollInterval: 15000
    cacheDir: .remote-cache
```

Od tej chwili kazdy `git push` zmieniajacy `apps/<id>/**` (po przejsciu przez
pipeline) pojawi sie w dzialajacym procesie jako nowy/zaktualizowany fiber -
bez restartu, bez przestoju pozostalych modulow (Corollary 62 z papieru:
odejscie/dodanie jednego fibera nie wplywa na pozostale).

### Test lokalny bez konta Cloudflare

`deploy/scripts/mock-registry-server.mjs` udaje pare R2+KV+Worker jednym
prostym serwerem HTTP (`GET /manifest.json`, `GET /artifacts/:id`,
`POST /publish`) - dokladnie tym mechanizmem zweryfikowano `@shop/remote-sync`
w tym repo (patrz `../README.md#status-weryfikacji`):

```sh
node deploy/scripts/mock-registry-server.mjs &         # domyslnie :7000
node deploy/scripts/publish-module.mjs product /tmp/out # buduje .tar.gz z apps/product/.output
curl -X POST "http://localhost:7000/publish?id=product&version=v1&config=%7B%22port%22%3A3001%2C%22inject%22%3A%5B%22cart%22%2C%22product%22%2C%22router%22%5D%2C%22route%22%3A%22%2Fproduct%22%7D&file=/tmp/out/product-v1.tar.gz"
```

## Dodanie nowego (czwartego+) modulu

Zero zmian w `@shop/nuxt-wrapper`/`@shop/broker`/serwisach - dowolna nowa
aplikacja Nuxt zbudowana Nitro-presetem `node-listener` dziala od razu.
Kroki (identyczne w obu modelach deploymentu):

1. Napisz aplikacje w `apps/<id>` (kopiujac strukture `apps/cart`).
2. Dopisz wpis w `cordis.yml` (Docker) LUB opublikuj przez pipeline (Cloudflare) -
   patrz `deploy/checkout-module-plan.md` po gotowy, w pelni rozpisany przyklad
   (modul `checkout`, celowo jeszcze nie zaimplementowany).
