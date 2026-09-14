import { getCordisContext } from '@shop/shared/bridge'
import { ensureCartId } from '@shop/shared/request-scope'

export default defineEventHandler(async (event) => {
  const ctx = getCordisContext(import.meta.url)
  const cartId = ensureCartId(event)
  const cart = ctx.get('cart')
  if (!cart) return { cartId, items: [], total: 0, itemCount: 0 }
  return await cart.snapshot(cartId)
})
