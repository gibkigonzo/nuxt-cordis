<script setup lang="ts">
import type { Product } from '@shop/shared'

useHead({ title: 'Katalog - Sklep Cordis' })

const { data: products } = await useFetch<Product[]>('/api/catalog')
const pending = ref<string | null>(null)
const message = ref('')

async function addToCart(product: Product) {
  pending.value = product.id
  message.value = ''
  try {
    await $fetch('/api/cart/add', { method: 'POST', body: { productId: product.id, quantity: 1 } })
    message.value = `Dodano "${product.name}" do koszyka.`
  } catch (error: any) {
    message.value = `Blad: ${error?.data?.statusMessage ?? error?.message ?? 'nieznany'}`
  } finally {
    pending.value = null
  }
}

function formatPrice(cents: number) {
  return (cents / 100).toFixed(2) + ' zl'
}
</script>

<template>
  <main class="shell">
    <p class="badge">modul @shop/module-product &middot; inject: cart, product</p>
    <div class="top">
      <h1>Katalog produktow</h1>
      <NuxtLink class="ghost" to="/cart">Przejdz do koszyka &rarr;</NuxtLink>
    </div>
    <p v-if="message" class="flash">{{ message }}</p>

    <section class="grid">
      <article v-for="product in products" :key="product.id" class="card">
        <div class="thumb" aria-hidden="true" />
        <h2>{{ product.name }}</h2>
        <p class="desc">{{ product.description }}</p>
        <div class="row">
          <span class="price">{{ formatPrice(product.price) }}</span>
          <button :disabled="pending === product.id" @click="addToCart(product)">
            {{ pending === product.id ? 'Dodaje…' : 'Dodaj do koszyka' }}
          </button>
        </div>
      </article>
    </section>

    <p class="hint">
      Katalog pochodzi z koefektu <code>ctx.get('product')</code>, dodanie do koszyka
      wywoluje <code>ctx.get('cart').add(...)</code> - obie operacje sa wywolaniami w
      pamieci procesu orchestratora. Strona i API sa czescia tego samego modulu
      (<code>@shop/module-product</code>), skompilowanego razem z resztą apps/shop.
    </p>
  </main>
</template>

<style scoped>
.flash { color: #7ee7b8; margin-top: 1rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.1rem; margin: 2rem 0; }
.card {
  background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08);
  border-radius: 1rem; padding: 1.1rem; display: flex; flex-direction: column; gap: .5rem;
}
.thumb { height: 96px; border-radius: .6rem; background: linear-gradient(135deg, #6d3fd6, #23103f); }
.card h2 { font-size: 1.05rem; margin: 0; }
.desc { font-size: .82rem; color: #b8adda; margin: 0; flex-grow: 1; }
.row { display: flex; align-items: center; justify-content: space-between; }
.price { font-weight: 600; color: #e4dbff; }
button {
  background: #7c4dff; color: white; border: none; border-radius: .5rem;
  padding: .5rem .8rem; font-size: .82rem; cursor: pointer;
}
button:disabled { opacity: .6; cursor: default; }
</style>
