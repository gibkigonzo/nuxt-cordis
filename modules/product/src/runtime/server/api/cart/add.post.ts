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
  if (body.quantity !== undefined && (!Number.isInteger(body.quantity) || body.quantity <= 0)) {
    // Granica systemu (wejscie uzytkownika) - `CartService.add()` robi `HINCRBY`
    // w Redis, wiec ujemna/niecalkowita ilosc dawalaby chwilowo ujemny stan
    // hasha widoczny przez `snapshot()` zanim warunkowy `hdel` go posprzata.
    throw createError({ statusCode: 400, statusMessage: 'quantity musi byc dodatnia liczba calkowita' })
  }
  const cartId = ensureCartId(event)
  const cart = ctx.get('cart')
  if (!cart) {
    throw createError({ statusCode: 503, statusMessage: 'koefekt "cart" niedostepny' })
  }
  return cart.add(cartId, body.productId, body.quantity ?? 1)
})
