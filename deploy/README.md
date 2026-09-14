# Deployment

Jedna udokumentowana, docelowa sciezka: **buduj jeden niezmienny obraz OCI w
CI, publikuj do rejestru, wdrazaj rolling update'em w Kubernetesie.** `docker
compose` ponizej to jedynie lokalny odpowiednik tego samego obrazu do testow
manualnych, nie osobny model produkcyjny.

Status weryfikacji kazdej czesci - patrz `../README.md#status-weryfikacji`.

## Docker (build lokalny / smoke test) {#docker}

Jeden kontener = caly system (jeden proces Node, jeden publiczny port: 8080).
Zweryfikowane w tym repo: `docker build`, `docker run`, ruch HTTP do JEDNEJ
aplikacji Nuxt (apps/shop, skladajacej modules/home, modules/product,
modules/cart - patrz ARCHITECTURE.md#10), wspoldzielony stan koszyka miedzy
nimi, oraz `docker stop` (graceful shutdown, ~160ms).

```sh
docker build -f deploy/docker/Dockerfile -t nuxt-cordis-shop:latest .
docker run -d -p 8080:8080 --name shop nuxt-cordis-shop:latest

curl http://localhost:8080/
curl http://localhost:8080/api/catalog

docker stop shop   # SIGTERM -> ctx.fiber.dispose() -> LIFO cleanup
```

lub przez compose:

```sh
docker compose -f deploy/docker/docker-compose.yml up --build
```

Ten sam `Dockerfile` jest jedynym zrodlem obrazu uzywanego pozniej w
Kubernetesie - `docker build` lokalnie i `docker build` w CI (patrz
`deploy/workflows/build-and-push.yml`) to identyczny proces, tylko wynik
trafia w innego miejsce (rejestr zamiast lokalnego demona).

## Kubernetes (produkcyjna sciezka wdrozenia) {#kubernetes}

Zastepuje wczesniejszy model oparty o Cloudflare R2/KV + `@shop/remote-sync`
(dynamiczne pobieranie i rozpakowywanie `.tar.gz` z kodem modulow w
dzialajacym procesie). Ten model zostal **swiadomie usuniety** z powodow
bezpieczenstwa - brak weryfikacji integralnosci artefaktu/manifestu, brak
sandboxa przy rozpakowaniu, kod importowany z pelnym dostepem do procesu i
wspoldzielonych koefektow, oraz brak jakiejkolwiek bramki autoryzacyjnej poza
kontrola dostepu do `main`/sekretow CI. Pelne uzasadnienie: `../ARCHITECTURE.md#8`.

**Nowy model: kod NIGDY nie jest pobierany przez siec w dzialajacym
procesie.** Aktualizacja KTOREGOKOLWIEK modulu (w tym pojedynczej aplikacji
Nuxt) = nowy build calego obrazu (git sha jako tag) + standardowy rolling
update. Cordis w tym modelu pozostaje WYLACZNIE orchestratorem kodu juz
zapieczonego w obrazie - `cordis.yml` jest czytany raz przy starcie procesu,
bez zadnego reconcilera zdalnej konfiguracji.

### Komponenty

| Komponent | Co robi |
|---|---|
| `deploy/docker/Dockerfile` | buduje CALY system (apps/shop, skladajaca modules/*, + orchestrator + uslugi) w jeden obraz |
| `deploy/workflows/build-and-push.yml` | CI: `docker build` + `docker push` do GHCR (tag = git sha, niezmienny), opcjonalnie `kubectl apply -k` |
| `deploy/k8s/` | manifesty: `namespace.yaml`, `deployment.yaml` (RollingUpdate, `maxUnavailable: 0`, readiness/liveness probe na `/`, non-root, `readOnlyRootFilesystem`), `service.yaml`, `kustomization.yaml` |

### Uruchomienie recznie (dowolny klaster)

```sh
docker build -f deploy/docker/Dockerfile -t ghcr.io/<owner>/nuxt-cordis-shop:<tag> .
docker push ghcr.io/<owner>/nuxt-cordis-shop:<tag>

kubectl apply -k deploy/k8s   # baza (namespace/Deployment/Service) - obraz domyslnie :latest
kubectl set image deployment/shop shop=ghcr.io/<owner>/nuxt-cordis-shop:<tag> -n shop
kubectl rollout status deployment/shop -n shop
```

(`kubectl apply -k` ma wbudowane wsparcie kustomize - nie potrzeba osobnej
binarki `kustomize`. `docker/build-push-action` w CI podaje zamiast `<tag>`
niezmienny digest (`@sha256:...`) - preferuj to samo recznie, jesli masz
digest, zamiast tagu, ktory teoretycznie moze zostac nadpisany w rejestrze.)

Rollback do poprzedniej wersji (bez rebuildu) - standardowy mechanizm k8s,
nie cos wlasnego:

```sh
kubectl rollout undo deployment/shop -n shop
```

Ruch do klastra (Ingress/LoadBalancer przed `Service shop`) zalezy od
dostawcy klastra i celowo nie jest tu zalozony - dopisz wlasny `Ingress`
obok `deploy/k8s/service.yaml` (lub `kubectl port-forward svc/shop 8080:80`
do testow).

### Aktywacja pipeline'u CI

1. Skopiuj `deploy/workflows/build-and-push.yml` do `.github/workflows/` w
   repo (trzymany poza `.github/` celowo, jako szablon do przejrzenia przed
   aktywacja - identyczna konwencja jak poprzedni, usuniety
   `deploy-module.yml`).
2. Job `build-and-push` dziala od razu (potrzebuje jedynie domyslnego
   `secrets.GITHUB_TOKEN` do publikacji na `ghcr.io`).
3. Job `deploy` jest domyslnie POMINIETY. Aby go wlaczyc:
   - ustaw `vars.KUBE_DEPLOY_ENABLED=true` w ustawieniach repo GitHub,
   - dodaj sekret `KUBE_CONFIG` = kubeconfig (base64) z dostepem
     ograniczonym do namespace `shop` w klastrze docelowym.
4. Bez kroku 3 obraz i tak zostaje opublikowany - wdrozenie recznym
   `kubectl apply -k deploy/k8s` (sekcja wyzej) dziala niezaleznie.

### Utwardzenie lancucha dostaw (ten sam rygor co przy usuwaniu remote-sync)

Usuniety `@shop/remote-sync` mial cztery konkretne problemy (brak integralnosci,
brak sandboxa, pelny dostep procesu, brak autoryzacji - patrz
`../ARCHITECTURE.md#8`). Nowy pipeline adresuje analogiczne kategorie ryzyka
we WLASNYM lancuchu dostaw (CI -> rejestr -> klaster):

- **Integralnosc:** kazda akcja strony trzeciej w `build-and-push.yml` jest
  przypieta do pelnego commit SHA (nie do ruchomego tagu typu `@v4`), a obraz
  jest budowany przez `docker/build-push-action` z `provenance: true` +
  `sbom: true` - kazdy pobierajacy obraz z GHCR moze zweryfikowac, CZYM
  faktycznie zostal zbudowany (`gh attestation verify oci://ghcr.io/<owner>/nuxt-cordis-shop:<tag> --owner <owner>`),
  zamiast ufac golemu tagowi.
- **Deployment po digescie, nie po tagu:** job `deploy` uzywa
  `kubectl set image deployment/shop shop=ghcr.io/<owner>/nuxt-cordis-shop@sha256:...`
  (digest z outputu builda), nie ruchomego `:latest` - `latest` w
  `deploy/k8s/deployment.yaml` jest wylacznie wartoscia domyslna dla
  recznego `kubectl apply -k` przy pierwszym wdrozeniu.
- **Minimalne uprawnienia per-job:** `permissions:` jest ustawione osobno
  dla kazdego joba (build-and-push: zapis do rejestru + `id-token` do
  atestacji; deploy: brak zadnych uprawnien do GitHuba, korzysta tylko z
  wlasnego `KUBE_CONFIG`), nie jeden szeroki blok na caly workflow.
- **Zero dodatkowych binarek/akcji trzecich stron ponad niezbedne minimum:**
  `deploy` uzywa WYLACZNIE `kubectl` (preinstalowany na `ubuntu-latest`,
  `apply -k` ma wbudowane wsparcie kustomize) - celowo bez osobnej
  akcji/binarki `kustomize`, zeby nie poszerzac powierzchni zaufania.
- **Autoryzacja:** trigger to `push` do `main` (chronionego brancha z
  wymaganym review, jesli tak skonfigurowano ochrone brancha w ustawieniach
  repo - to poza zakresem samego workflow) - jedyna bramka to nadal kontrola
  dostepu do `main`, identycznie jak przy poprzednim modelu, ale teraz bez
  drugiego, rownoleglego kanalu (nieautoryzowanego zdalnego `fetch()+tar`)
  omijajacego ten sam pipeline.

**ZALECANE, NIE zaimplementowane** (zalezy od dostawcy klastra, wiec celowo
pozostawione jako rekomendacja a nie kod): zastapienie dlugozyjacego sekretu
`KUBE_CONFIG` krotkotrwalym uwierzytelnieniem przez OIDC (GKE Workload
Identity Federation, EKS IRSA lub odpowiednik) - ten sam kierunek co juz
zastosowany dla publikacji obrazu (`id-token: write` + Sigstore zamiast
statycznego tokenu).

**WAZNE:** ten pipeline (jak poprzedni, oparty o Cloudflare) NIE zostal
uruchomiony end-to-end na prawdziwym klastrze/rejestrze w tej sesji (brak
dostepnych danych uwierzytelniajacych) - manifesty i workflow sa napisane
wedlug udokumentowanego, poprawnego API (`kubectl`/GHCR/`docker/build-push-action`),
ale zweryfikuj przed uzyciem produkcyjnym. Patrz `../README.md#status-weryfikacji`.

## Dodanie nowego (czwartego+) modulu

Od wersji z JEDNA appka Nuxt (`apps/shop`, patrz ARCHITECTURE.md#10) dodanie
modulu NIE dotyka `cordis.yml` ani `deploy/docker/Dockerfile` w ogole - to
zmiana WYLACZNIE wewnatrz builda `apps/shop`. Kroki:

1. Napisz `modules/<id>` (kopiujac strukture `modules/cart` - `src/module.ts`
   + `src/runtime/pages`/`src/runtime/server`).
2. Dopisz `'@shop/module-<id>'` do listy `modules` w `apps/shop/nuxt.config.ts`
   oraz `"@shop/module-<id>": "workspace:*"` do `apps/shop/package.json`.
3. Normalny `git push` -> CI buduje nowy obraz (JEDEN build `apps/shop`,
   zawierajacy juz nowy modul) -> rolling update.
4. Modul moze zostac wgrany, ale WYLACZONY (patrz
   `deploy/checkout-module-plan.md` po pelny, rozpisany przyklad - modul
   `checkout`, celowo jeszcze nie zaimplementowany) - `services/feature-registry-service`
   pozwala pozniej wlaczyc go bez kolejnego rebuildu/deploymentu.
