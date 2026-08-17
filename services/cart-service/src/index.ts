import { Service, type Context } from 'cordis'
import type { CartSnapshot } from '@shop/shared'

declare module 'cordis' {
  interface Context {
    cart: CartService
  }
}

/**
 * CartService: koefekt 'cart'. Cala logika stanu koszyka zyje TU, w jednym miejscu,
 * niezaleznie od tego, ktora aplikacja Nuxt go odpytuje (home/product/cart/checkout) -
 * to jest sedno "komunikacji bez narzutu sieciowego" (Section 6.1/6.2 papieru Cordis):
 * `ctx.get('cart')` to zwykle wywolanie metody w pamieci, nie request HTTP.
 *
 * Stan jest trzymany w pamieci procesu (Map), wiec przetrwa hot-reload dowolnej
 * aplikacji Nuxt (te sa niezalezne od CartService), ale NIE przetrwa restartu calego
 * procesu orchestratora - to swiadomy wybor dla demonstracji: gdyby potrzebna byla
 * trwalosc, CartService pozostaje jedynym miejscem, gdzie trzeba by dodac
 * efekt (ctx.effect) otwierajacy polaczenie do bazy danych.
 */
export class CartService extends Service {
  state: Map<string, Map<string, number>>

  constructor(ctx: Context) {
    super(ctx, 'cart')
    this.state = new Map()
  }

  private bucket(cartId: string): Map<string, number> {
    let b = this.state.get(cartId)
    if (!b) this.state.set(cartId, (b = new Map()))
    return b
  }

  add(cartId: string, productId: string, quantity = 1): CartSnapshot {
    const bucket = this.bucket(cartId)
    const next = Math.max(0, (bucket.get(productId) ?? 0) + quantity)
    if (next === 0) bucket.delete(productId)
    else bucket.set(productId, next)
    return this.snapshot(cartId)
  }

  removeItem(cartId: string, productId: string): CartSnapshot {
    this.bucket(cartId).delete(productId)
    return this.snapshot(cartId)
  }

  clear(cartId: string): CartSnapshot {
    this.state.delete(cartId)
    return this.snapshot(cartId)
  }

  /**
   * Migawka koszyka wzbogacona o dane produktowe - jesli koefekt 'product' jest
   * akurat dostepny. To OPCJONALNY (nie deklarowany przez `inject`) odczyt: jesli
   * ProductService nie jest zaladowany, snapshot po prostu nie zna nazw/cen.
   */
  snapshot(cartId: string): CartSnapshot {
    const bucket = this.bucket(cartId)
    const productService = this.ctx.get('product')
    let total = 0
    const items = [...bucket.entries()].map(([productId, quantity]) => {
      const product = productService?.find(productId)
      const lineTotal = (product?.price ?? 0) * quantity
      total += lineTotal
      return { productId, quantity, name: product?.name, price: product?.price, lineTotal }
    })
    return { cartId, items, total, itemCount: items.reduce((n, i) => n + i.quantity, 0) }
  }
}

export default CartService
