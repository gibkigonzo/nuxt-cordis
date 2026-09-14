import { Service, type Context } from 'cordis'
import Redis from 'ioredis'

declare module 'cordis' {
  interface Context {
    redis: RedisService
  }
}

export interface RedisServiceConfig {
  /** connection string Redis - domyslnie process.env.REDIS_URL, w ostatecznosci localhost */
  url?: string
}

/**
 * RedisService: koefekt 'redis'. Jedno, wspoldzielone polaczenie Redis per
 * proces - zrodlo prawdy dla stanu, ktory MUSI byc spojny miedzy wieloma
 * replikami (podami) tego samego obrazu (stan koszyka, wlaczone/wylaczone
 * moduly) - patrz services/cart-service i services/feature-registry-service.
 * W przeciwienstwie do nich `ProductService` CELOWO zostaje lokalny/w pamieci -
 * katalog to statyczne dane identyczne w kazdym podzie (ta sama wersja
 * obrazu), wiec nie ma tam nic do synchronizacji.
 *
 * `ctx.redis.client` wystawia surowego klienta `ioredis` - ten serwis NIE
 * opakowuje pojedynczych komend wlasnymi metodami (byloby to nieszczere -
 * cart-service/feature-registry-service i tak musza znac ksztalt wlasnych
 * kluczy/hashy, wiec dodatkowa warstwa niczego by nie ukryla).
 *
 * Kompromis (swiadomy, patrz ARCHITECTURE.md): jeden, pojedynczy Redis bez
 * replikacji/Sentinela - nowy pojedynczy punkt awarii calego systemu w
 * zamian za spojnosc miedzy podami. Prawdziwa odpornosc (Sentinel/Cluster)
 * to osobny, wiekszy projekt, celowo NIE podjety bez wyraznej prosby.
 *
 * WAZNE (zweryfikowane empirycznie, nie zgaduj inaczej): koefekt 'redis'
 * staje sie dostepny dla `static inject = ['redis']` (cart-service,
 * feature-registry-service) NATYCHMIAST po skonstruowaniu tej klasy, NIE
 * dopiero po udanym polaczeniu - `ctx.effect()` w konstruktorze rejestruje
 * efekt asynchronicznie, ale nie blokuje samego dostarczenia koefektu. W
 * praktyce oznacza to, ze `shop` (i wszystkie moduly) zaczynaja nasluchiwac
 * NAWET gdy Redis jest jeszcze niedostepny - pojedyncze requesty dotykajace
 * `ctx.redis.client` po prostu czekaja w wewnetrznej kolejce `ioredis`
 * (`enableOfflineQueue`, domyslnie wlaczone) do `maxRetriesPerRequest` prob
 * polaczenia (ponizej), po czym albo sie powiedzie, albo request zawiedzie
 * z czytelnym bledem - nie ma tu "trwalej blokady calego systemu". Dlatego
 * `deploy/k8s/deployment.yaml` rozdziela readiness (`/`, wymaga dzialajacego
 * Redisa) od liveness (`/healthz`, zero zaleznosci od Redis/Cordis) - patrz
 * ARCHITECTURE.md#shared-state.
 */
export class RedisService extends Service<RedisServiceConfig> {
  client: Redis

  constructor(ctx: Context, config: RedisServiceConfig = {}) {
    super(ctx, 'redis')
    const url = config.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
    // `ioredis` juz DOMYSLNIE probuje ponownie w nieskonczonosc (wbudowany
    // retryStrategy `times => min(times*50, 2000)`) - ponizej to celowe,
    // jawne dostosowanie krzywej backoffu (wolniejsza, do 5s zamiast 2s), nie
    // wprowadzenie retry tam, gdzie go wczesniej nie bylo.
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
    })

    // Bez wlasnego listenera 'error' ioredis wypisuje kazdy blad polaczenia
    // (np. ECONNREFUSED podczas oczekiwania na gotowosc Redisa) jako "Unhandled
    // error event" wprost na konsole, z pominieciem ctx.logger - przechwytujemy
    // je tutaj, zeby trafialy do tego samego loggera co reszta systemu. Sama
    // retry-logika (ponizej retryStrategy) i tak dziala niezaleznie od tego listenera.
    this.client.on('error', (error) => {
      ctx.logger.warn(`[redis] blad polaczenia: ${(error as Error).message}`)
    })

    ctx.effect(async () => {
      await this.client.connect()
      ctx.logger.info(`[redis] polaczono (${url})`)
      return async () => {
        await this.client.quit()
      }
    }, 'redis:connection')
  }
}

export default RedisService
