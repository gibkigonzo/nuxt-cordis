import { getCordisContext } from '@shop/shared/bridge'

export default defineEventHandler((event) => {
  const ctx = getCordisContext(import.meta.url)
  const cartId = ensureCartId(event)
  return ctx.get('cart')?.snapshot(cartId) ?? { cartId, items: [], total: 0, itemCount: 0 }
})
