import type { H3Event } from 'h3'
import { randomUUID } from 'node:crypto'

const COOKIE_NAME = 'cart_id'

/**
 * Jeden wspoldzielony identyfikator koszyka na przegladarke, widoczny we
 * wszystkich aplikacjach (cookie z path='/', wiec dziala niezaleznie od tego,
 * pod jakim prefiksem broker wystawia dana instancje).
 */
export function ensureCartId(event: H3Event): string {
  let id = getCookie(event, COOKIE_NAME)
  if (!id) {
    id = randomUUID()
    setCookie(event, COOKIE_NAME, id, { path: '/', httpOnly: true, sameSite: 'lax' })
  }
  return id
}
