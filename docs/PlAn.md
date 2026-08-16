Budowa sklepu opartego na wielu instancjach Nuxt zarządzanych przez Cordis wymaga przejścia z modelu "wielu osobnych kontenerów" na model współdzielonego kontekstu runtime. Poniżej znajduje się plan budowy takiej architektury, uwzględniający trzy instancje Nuxt oraz niezbędne usługi pomocnicze.
1. Stworzenie komponentu "Nuxt Wrapper"
Nuxt nie jest natywnie zgodny z Cordis, więc pierwszym krokiem jest stworzenie uniwersalnego komponentu, który będzie potrafił zarządzać cyklem życia instancji Nuxt
.
Zadanie: Komponent musi implementować funkcję apply, która uruchamia Nuxt programowo (loadNuxt, build, listen)
.
Temporalność: Kluczowe jest zwrócenie funkcji dispose (odwrotności efektu), która wywoła nuxt.close(). Dzięki temu Cordis będzie mógł zamknąć konkretną aplikację bez zabijania całego procesu Node.js
,
.
Konfiguracja: Komponent powinien przyjmować w config ścieżkę do katalogu projektu oraz port, na którym ma nasłuchiwać
.
2. Definicja Wspólnych Usług (Coeffects)
Aby instancje mogły się komunikować (np. Karta Produktu musi dodać coś do Koszyka), musisz zdefiniować współdzielone usługi jako koefekty
,
.
CartService: Usługa zarządzająca stanem koszyka. Będzie zarejestrowana w głównym kontekście za pomocą ctx.set('cart', ...)
.
ProductService: Usługa dostarczająca dane o produktach.
Zaleta: Instancja "Koszyk" będzie dostawcą danych, a instancja "Karta Produktu" będzie ich konsumentem poprzez deklarację inject: ['cart'] w swojej specyfikacji
,
.
3. Plan Konfiguracji Deklaratywnej
Zamiast ręcznie uruchamiać każdy skrypt, użyjesz Loadera komponentów, który zarządza wpisami (entries)
. Twój plan zakłada 3 wpisy:
Wpis 1 (Home Page): URL do wrappera Nuxt, config: { path: './apps/home', port: 3000 }.
Wpis 2 (Product Card): URL do wrappera Nuxt, config: { path: './apps/product', port: 3001 }, inject: ['cart'].
Wpis 3 (Cart): URL do wrappera Nuxt, config: { path: './apps/cart', port: 3002 }.
4. Izolacja i Multiplexing (Co jeszcze jest potrzebne?)
Aby ten system działał wydajnie, potrzebujesz dwóch dodatkowych elementów:
Isolation Realms (Izolacja): Każda instancja Nuxt powinna działać we własnym realmie izolacji dla kluczy, które nie powinny być współdzielone (np. specyficzne konfiguracje renderowania), aby uniknąć konfliktów nazw
,
.
Service Broker (Bramka): Potrzebujesz małego proxy (np. opartego na usłudze Cordis), które będzie kierować ruch użytkownika na odpowiednie porty (3000, 3001, 3002) w zależności od ścieżki URL. Broker ten może być również komponentem Cordis, co pozwoli na jego aktualizację "w locie"
,
.
5. Workflow Deweloperski (HMR)
Do planu należy dołączyć komponent @cordisjs/hmr
.
Dlaczego: Gdy zmienisz kod w aplikacji "Koszyk", Cordis wykryje zmianę, wywoła dispose() tylko dla tej instancji (zamykając serwer na porcie 3002) i natychmiast uruchomi ją ponownie z nowym kodem
. Pozostałe instancje (Strona Główna, Karta Produktu) pozostaną aktywne i zachowają swój stan w pamięci
,
.
Podsumowanie Planu:
Wrapper: Kod JS zamieniający Nuxt w komponent Cordis (Start/Stop).
Services: Definicja CartService jako współdzielonego koefektu.
Config: Plik YAML/JSON z definicją 3 instancji Nuxt.
Orchestrator: Główny proces Cordis uruchamiający Loader.
Proxy: Prosty router usług kierujący ruch HTTP do odpowiednich instancji.
Tak przygotowany plan pozwala na budowę sklepu jako modułowego monolitu runtime, gdzie każda część jest niezależna, ale współdzieli zasoby i komunikuje się bez narzutu sieciowego
