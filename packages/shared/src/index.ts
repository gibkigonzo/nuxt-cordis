export * from './bridge.ts'

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
