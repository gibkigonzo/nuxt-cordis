import { Service, type Context } from 'cordis'
import type { CartSnapshot } from '@shop/shared'
// import samych deklaracji `declare module 'cordis'` z redis-service (augmentacja
// ctx.redis dla edytora/TS) - `import type` jest zawsze usuwany przez
// type-stripping, wiec brak wplywu na runtime. Realna zaleznosc runtime jest
// deklarowana przez `static inject = ['redis']` ponizej.
import type {} from '@shop/redis-service'

declare module 'cordis' {
  interface Context {
    cart: CartService
  }
}

/** TTL koszyka w Redis (7 dni od OSTATNIEJ aktywnosci - kazdy zapis go odswieza). */
const CART_TTL_SECONDS = 60 * 60 * 24 * 7

/**
 * CartService: koefekt 'cart'. Cala logika stanu koszyka zyje TU, w jednym
 * miejscu, niezaleznie od tego, ktory modul Nuxta go odpytuje (home/product/cart) -
 * to jest sedno "komunikacji bez narzutu sieciowego" (Section 6.1/6.2 papieru
 * Cordis): `ctx.get('cart')` to zwykle wywolanie metody w pamieci, nie
 * request HTTP.
 *
 * Stan zyje w Redis (koefekt 'redis'), NIE w lokalnej pamieci procesu - w
 * przeciwienstwie do `ProductService` (statyczny katalog, identyczny w
 * kazdej replice, wiec bezpieczny lokalnie), koszyk jest MUTOWALNYM stanem,
 * ktory MUSI byc spojny miedzy wieloma podami tego samego obrazu (patrz
 * ARCHITECTURE.md - deployment k8s domyslnie uzywa `replicas: 2`+, bez
 * sticky sessions). Kazdy koszyk to Redis Hash pod kluczem
 * `shop:cart:<cartId>` (pole = productId, wartosc = ilosc).
 */
export class CartService extends Service {
  static inject = ['redis']

  constructor(ctx: Context) {
    super(ctx, 'cart')
  }

  private key(cartId: string): string {
    return `shop:cart:${cartId}`
  }

  async add(cartId: string, productId: string, quantity = 1): Promise<CartSnapshot> {
    const key = this.key(cartId)
    // hincrby+expire w jednym pipeline (1 round trip zamiast 2) - `expire` nie
    // zalezy od wyniku `hincrby`, wiec moga jechac razem; `hdel` zostaje
    // osobnym wywolaniem, bo zalezy od wyniku `hincrby` (warunkowe).
    const [[, next]] = (await this.ctx.redis.client
      .pipeline()
      .hincrby(key, productId, quantity)
      .expire(key, CART_TTL_SECONDS)
      .exec()) as [[Error | null, number], [Error | null, number]]
    if (next <= 0) await this.ctx.redis.client.hdel(key, productId)
    return this.snapshot(cartId)
  }

  async removeItem(cartId: string, productId: string): Promise<CartSnapshot> {
    const key = this.key(cartId)
    // `expire` tutaj rowniez odswieza TTL (patrz docstring klasy - kazdy
    // zapis, nie tylko `add()`, odswieza 7-dniowe okno od ostatniej aktywnosci).
    await this.ctx.redis.client.pipeline().hdel(key, productId).expire(key, CART_TTL_SECONDS).exec()
    return this.snapshot(cartId)
  }

  async clear(cartId: string): Promise<CartSnapshot> {
    await this.ctx.redis.client.del(this.key(cartId))
    // Bez snapshot(cartId) tutaj - wynik jest deterministycznie pusty (klucz
    // wlasnie usuniety), wiec kolejny HGETALL bylby czystym, zmarnowanym
    // round tripem do Redis.
    return { cartId, items: [], total: 0, itemCount: 0 }
  }

  /**
   * Migawka koszyka wzbogacona o dane produktowe - jesli koefekt 'product' jest
   * akurat dostepny. To OPCJONALNY (nie deklarowany przez `inject`) odczyt: jesli
   * ProductService nie jest zaladowany, snapshot po prostu nie zna nazw/cen.
   */
  async snapshot(cartId: string): Promise<CartSnapshot> {
    const raw = await this.ctx.redis.client.hgetall(this.key(cartId))
    const productService = this.ctx.get('product')
    let total = 0
    let itemCount = 0
    const items = Object.entries(raw).map(([productId, quantityRaw]) => {
      const quantity = Number(quantityRaw)
      const product = productService?.find(productId)
      const lineTotal = (product?.price ?? 0) * quantity
      total += lineTotal
      itemCount += quantity
      return { productId, quantity, name: product?.name, price: product?.price, lineTotal }
    })
    return { cartId, items, total, itemCount }
  }
}

export default CartService
