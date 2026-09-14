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
 */
export class RedisService extends Service<RedisServiceConfig> {
  client: Redis

  constructor(ctx: Context, config: RedisServiceConfig = {}) {
    super(ctx, 'redis')
    const url = config.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 })

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
