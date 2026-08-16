import { getCordisContext } from '@shop/shared/bridge'

interface RemoveBody {
  productId: string
}

export default defineEventHandler(async (event) => {
  const ctx = getCordisContext(import.meta.url)
  const body = await readBody<RemoveBody>(event)
  if (!body?.productId) {
    throw createError({ statusCode: 400, statusMessage: 'productId jest wymagane' })
  }
  const cartId = ensureCartId(event)
  const cart = ctx.get('cart')
  if (!cart) throw createError({ statusCode: 503, statusMessage: 'koefekt "cart" niedostepny' })
  return cart.removeItem(cartId, body.productId)
})
