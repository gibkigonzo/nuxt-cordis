import { getCordisContext } from '@shop/shared/bridge'

/**
 * Odczyt koefektu 'product' z zywego kontekstu Cordis (przez most) - to zwykle
 * wywolanie metody w pamieci procesu, nie request HTTP do innej uslugi.
 */
export default defineEventHandler(() => {
  const ctx = getCordisContext(import.meta.url)
  return ctx.get('product')?.list() ?? []
})
