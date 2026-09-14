import type { H3Event } from 'h3'
import { getCookie, setCookie } from 'h3'
import { randomUUID } from 'node:crypto'

const COOKIE_NAME = 'cart_id'

/**
 * Warstwa "request scope" (patrz ARCHITECTURE.md#10): dane wyliczane PER REQUEST,
 * nie trzymane w koefekcie ani w globalnym stanie. Jeden wspoldzielony identyfikator
 * koszyka na przegladarke, widoczny we wszystkich aplikacjach (cookie z path='/',
 * wiec dziala niezaleznie od tego, pod jakim prefiksem broker wystawia dana
 * instancje). Zyje w `packages/shared`, nie w `server/utils/*` pojedynczej apki,
 * zeby `apps/product` i `apps/cart` nie utrzymywaly dwoch kopii tej samej logiki.
 */
export function ensureCartId(event: H3Event): string {
  let id = getCookie(event, COOKIE_NAME)
  if (!id) {
    id = randomUUID()
    setCookie(event, COOKIE_NAME, id, { path: '/', httpOnly: true, sameSite: 'lax' })
  }
  return id
}
