import type { H3Event } from 'h3'
import { randomUUID } from 'node:crypto'

const COOKIE_NAME = 'cart_id'

export function ensureCartId(event: H3Event): string {
  let id = getCookie(event, COOKIE_NAME)
  if (!id) {
    id = randomUUID()
    setCookie(event, COOKIE_NAME, id, { path: '/', httpOnly: true, sameSite: 'lax' })
  }
  return id
}
