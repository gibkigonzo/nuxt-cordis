import type { H3Event } from 'h3'
import { getCookie, setCookie } from 'h3'
import { randomUUID } from 'node:crypto'

const COOKIE_NAME = 'cart_id'

/**
 * Warstwa "request scope" (patrz ARCHITECTURE.md#10): dane wyliczane PER REQUEST,
 * nie trzymane w koefekcie ani w globalnym stanie. Jeden wspoldzielony identyfikator
 * koszyka na przegladarke (cookie z path='/', widoczny na kazdej stronie tej
 * samej, jednej appki `apps/shop`). Zyje w `packages/shared`, nie w
 * `server/utils/*` `apps/shop`, zeby `modules/product` i `modules/cart` (dwa
 * niezalezne Nuxt Modules skladane w te sama appke, kazdy z wlasnymi server
 * routes odczytujacymi/mutujacymi koszyk) nie utrzymywaly dwoch kopii tej
 * samej logiki.
 */
export function ensureCartId(event: H3Event): string {
  let id = getCookie(event, COOKIE_NAME)
  if (!id) {
    id = randomUUID()
    setCookie(event, COOKIE_NAME, id, { path: '/', httpOnly: true, sameSite: 'lax' })
  }
  return id
}
