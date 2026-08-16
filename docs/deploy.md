Wprowadzenie czwartego modułu (czwartej aplikacji Nuxt) w paradygmacie Cordis zmienia proces z „wymiany całej infrastruktury” na **dynamiczną rekonfigurację wewnątrz działającego procesu**. Twoje flow z użyciem GitHub Actions i Cloudflare będzie wyglądać bardzo podobnie na etapie kodu, ale „pod spodem” zadzieje się magia, która pozwoli uniknąć restartu pozostałych trzech modułów.

Oto jak wyglądałby ten proces krok po kroku:

### 1. Etap deweloperski i Git
*   **Zmiana w kodzie:** Tworzysz nowy folder `apps/checkout` (czwarty moduł) i aktualizujesz plik konfiguracji deklaratywnej (np. `config.yml`), dodając tam nowy wpis.
*   **Push:** Robisz `git push` i mergujesz do mastera.

### 2. Pipeline (GitHub Actions)
Zamiast budować obraz kontenera dla całego sklepu, pipeline wykonuje następujące kroki:
*   **Budowa modułu:** Kompiluje tylko nowy moduł (checkout).
*   **Dostarczenie (Cloudflare R2/KV):** Wypychasz zbudowane pliki (kod JS modułu) do **Cloudflare R2** (storage) lub **Cloudflare KV** (key-value store). W Cordis moduły są ładowane przez URL, więc Twój moduł jest teraz dostępny pod adresem np. `https://cdn.twojsklep.pl/modules/checkout.js`.
*   **Aktualizacja "Source of Truth":** Pipeline aktualizuje centralny plik konfiguracji (lub rekord w KV), który śledzi Twój działający orchestrator Cordis.

### 3. Runtime i „Deployment” w Cordis (Cloudflare Workers)
Tutaj następuje kluczowa różnica względem k8s. Twoja aplikacja matka (orchestrator), działająca np. na **Cloudflare Workers**, wykrywa zmianę w konfiguracji (reconciliation):

*   **Detekcja nowego wpisu:** Loader Cordis widzi, że w konfiguracji pojawił się czwarty element, którego nie ma w pamięci.
*   **Dynamiczne ładowanie (ctx.use):** System nie restartuje pozostałych trzech instancji Nuxta. Zamiast tego, wewnątrz działającego procesu, wywołuje funkcję `ctx.use()` dla nowego modułu.
*   **Reaktywne okablowanie (Spatial Composability):** 
    *   Nowy moduł Checkout deklaruje, że potrzebuje usługi `CartService` (koefekt). 
    *   Cordis automatycznie „podpina” go pod działającą już usługę koszyka, którą dostarcza moduł trzeci.
    *   Wszystko to dzieje się bez przerywania sesji użytkowników, którzy właśnie przeglądają kartę produktu w drugim module.

### Dlaczego to jest lepsze niż k8s w tym przypadku?
1.  **Brak zimnego startu (No Cold Start):** Moduły 1, 2 i 3 działają nieprzerwanie. Ich lokalne cache i połączenia pozostają nienaruszone.
2.  **Transactional Reload:** Gdybyś zamiast dodawać moduł, aktualizował istniejący, Cordis wykonałby **transakcyjne przeładowanie**. Jeśli nowy kod modułu 4 miałby błąd (np. błąd składni), system automatycznie wycofałby zmiany i przywrócił poprzednią działającą wersję tylko dla tego modułu, nie wpływając na resztę aplikacji.
3.  **Granularność:** W Cloudflare Workers masz limity pamięci i czasu procesora. Zamiast płacić za restart całego wielkiego kontenera w k8s, po prostu „dostrzykujesz” nową logikę do działającego środowiska.

**Podsumowując:** W Cordis Twój pipeline nie podmienia „paczki”, ale wysyła sygnał do żywego organizmu, że ma „wyhodować” sobie nowy organ (czwarty moduł) z dostępnego pod adresem URL kodu. Wszystkie zależności (koefekty) zostaną połączone automatycznie w czasie rzeczywistym.