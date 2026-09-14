import { getCordisContext } from '@shop/shared/bridge'
import { ensureCartId } from '@shop/shared/request-scope'

export default defineEventHandler((event) => {
  const ctx = getCordisContext(import.meta.url)
  const cartId = ensureCartId(event)
  const cart = ctx.get('cart')
  if (!cart) throw createError({ statusCode: 503, statusMessage: 'koefekt "cart" niedostepny' })
  return cart.clear(cartId)
})
