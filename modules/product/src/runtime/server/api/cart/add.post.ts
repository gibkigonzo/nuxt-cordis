import { getCordisContext } from '@shop/shared/bridge'
import { ensureCartId } from '@shop/shared/request-scope'

interface AddBody {
  productId: string
  quantity?: number
}

export default defineEventHandler(async (event) => {
  const ctx = getCordisContext(import.meta.url)
  const body = await readBody<AddBody>(event)
  if (!body?.productId) {
    throw createError({ statusCode: 400, statusMessage: 'productId jest wymagane' })
  }
  const cartId = ensureCartId(event)
  const cart = ctx.get('cart')
  if (!cart) {
    throw createError({ statusCode: 503, statusMessage: 'koefekt "cart" niedostepny' })
  }
  return cart.add(cartId, body.productId, body.quantity ?? 1)
})
