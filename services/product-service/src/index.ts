import { Service, type Context } from 'cordis'
import type { Product } from '@shop/shared'

declare module 'cordis' {
  interface Context {
    product: ProductService
  }
}

const CATALOG: Product[] = [
  {
    id: 'sku-001',
    name: 'Kubek Cordis',
    price: 4900,
    description: 'Ceramiczny kubek 350ml z logo spatiotemporal composability.',
    image: '/images/mug.svg',
  },
  {
    id: 'sku-002',
    name: 'Koszulka Fiber',
    price: 9900,
    description: 'Bawelniana koszulka - dostepna, dopoki fiber jest ACTIVE.',
    image: '/images/tshirt.svg',
  },
  {
    id: 'sku-003',
    name: 'Naklejki Coeffect',
    price: 1500,
    description: 'Zestaw 5 naklejek: effect, coeffect, fiber, context, revert.',
    image: '/images/sticker.svg',
  },
]

/**
 * ProductService: koefekt 'product'. Prosty, w pelni synchroniczny katalog
 * w pamieci - wystarczajacy, by pokazac wstrzykiwanie miedzy niezaleznie
 * budowanymi i wdrazanymi aplikacjami Nuxt.
 */
export class ProductService extends Service {
  catalog: Map<string, Product>

  constructor(ctx: Context) {
    super(ctx, 'product')
    this.catalog = new Map(CATALOG.map((p) => [p.id, p]))
  }

  list(): Product[] {
    return [...this.catalog.values()]
  }

  find(id: string): Product | undefined {
    return this.catalog.get(id)
  }
}

export default ProductService
