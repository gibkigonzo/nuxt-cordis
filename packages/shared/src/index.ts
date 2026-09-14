// UWAGA: `bridge.ts` (i `request-scope.ts`) CELOWO NIE sa tu re-eksportowane.
// Ten plik ("@shop/shared" - entrypoint ".") jest jedynym importem dozwolonym
// z kodu klienckiego Nuxta (typy ponizej + COEFFECT_KEYS - czyste dane, zero
// logiki), a "server-only" funkcje (dostep do zywego ctx Cordis, wyliczanie
// per-request cart-id) wymagaja jawnego importu z podsciezki ("@shop/shared/bridge",
// "@shop/shared/request-scope"). Bez tego rozdzielenia jeden `export *` w tym
// pliku wciagalby bridge do KAZDEGO importu "@shop/shared", w tym z komponentow
// .vue budowanych do bundla przegladarki - patrz ARCHITECTURE.md#10 (warstwa 9,
// "wazny podzial paczki" z analizy AI, ktora zainspirowala to rozdzielenie).

export interface Product {
  id: string
  name: string
  /** cena w groszach */
  price: number
  description?: string
  image?: string
}

export interface CartItem {
  productId: string
  quantity: number
}

export interface CartLine extends CartItem {
  name?: string
  price?: number
  lineTotal?: number
}

export interface CartSnapshot {
  cartId: string
  items: CartLine[]
  /** suma w groszach */
  total: number
  itemCount: number
}

export interface RouteTarget {
  host: string
  port: number
  id: string
}

/** Klucze koefektow - jedno miejsce prawdy dla nazw uslug wspoldzielonych przez ctx. */
export const COEFFECT_KEYS = {
  cart: 'cart',
  product: 'product',
  router: 'router',
} as const
