# Deployment

Jedna udokumentowana, docelowa sciezka: **buduj jeden niezmienny obraz OCI w
CI, publikuj do rejestru, wdrazaj rolling update'em w Kubernetesie.** `docker
compose` ponizej to jedynie lokalny odpowiednik tego samego obrazu do testow
manualnych, nie osobny model produkcyjny.

Status weryfikacji kazdej czesci - patrz `../README.md#status-weryfikacji`.

## Docker (build lokalny / smoke test) {#docker}

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
| `deploy/docker/Dockerfile` | buduje CALY system (home + product + cart + orchestrator) w jeden obraz |
| `deploy/workflows/build-and-push.yml` | CI: `docker build` + `docker push` do GHCR (tag = git sha, niezmienny), opcjonalnie `kubectl apply -k` |
| `deploy/k8s/` | manifesty: `namespace.yaml`, `deployment.yaml` (RollingUpdate, `maxUnavailable: 0`, readiness/liveness probe na `/`, non-root, `readOnlyRootFilesystem`), `service.yaml`, `kustomization.yaml` |

### Uruchomienie recznie (dowolny klaster)

```sh
docker build -f deploy/docker/Dockerfile -t ghcr.io/<owner>/nuxt-cordis-shop:<tag> .
docker push ghcr.io/<owner>/nuxt-cordis-shop:<tag>

cd deploy/k8s
kustomize edit set image ghcr.io/<owner>/nuxt-cordis-shop=ghcr.io/<owner>/nuxt-cordis-shop:<tag>
kubectl apply -k .
kubectl rollout status deployment/shop -n shop
```

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

**WAZNE:** ten pipeline (jak poprzedni, oparty o Cloudflare) NIE zostal
uruchomiony end-to-end na prawdziwym klastrze/rejestrze w tej sesji (brak
dostepnych danych uwierzytelniajacych) - manifesty i workflow sa napisane
wedlug udokumentowanego, poprawnego API (`kubectl`/`kustomize`/GHCR), ale
zweryfikuj przed uzyciem produkcyjnym. Patrz `../README.md#status-weryfikacji`.

## Dodanie nowego (czwartego+) modulu

Zero zmian w `@shop/nuxt-wrapper`/`@shop/broker`/serwisach - dowolna nowa
aplikacja Nuxt zbudowana Nitro-presetem `node-listener` dziala od razu.
Kroki:

1. Napisz aplikacje w `apps/<id>` (kopiujac strukture `apps/cart`).
2. Dopisz wpis w `cordis.yml` (patrz `deploy/checkout-module-plan.md` po
   gotowy, w pelni rozpisany przyklad - modul `checkout`, celowo jeszcze nie
   zaimplementowany).
3. Dopisz `COPY --from=build /app/apps/<id>/.output ...` w
   `deploy/docker/Dockerfile` (i odpowiedni wpis w `deploy/workflows/build-and-push.yml`,
   jesli chcesz osobny filtr `paths`).
4. Normalny `git push` -> CI buduje nowy obraz -> rolling update.
