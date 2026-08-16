<script setup lang="ts">
import type { CartSnapshot } from '@shop/shared'

useHead({ title: 'Koszyk - Sklep Cordis' })

const { data: cart, refresh } = await useFetch<CartSnapshot>('/api/cart')
const busy = ref<string | null>(null)

function formatPrice(cents: number) {
  return (cents / 100).toFixed(2) + ' zl'
}

async function removeItem(productId: string) {
  busy.value = productId
  try {
    await $fetch('/api/cart/remove', { method: 'POST', body: { productId } })
    await refresh()
  } finally {
    busy.value = null
  }
}

async function clearCart() {
  busy.value = 'clear'
  try {
    await $fetch('/api/cart/clear', { method: 'POST' })
    await refresh()
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <main class="shell">
    <p class="badge">apps/cart &middot; port 3002 &middot; inject: cart</p>
    <div class="top">
      <h1>Koszyk</h1>
      <a class="ghost" href="/product">&larr; Wroc do katalogu</a>
    </div>

    <section v-if="cart && cart.items.length" class="list">
      <article v-for="item in cart.items" :key="item.productId" class="line">
        <div>
          <strong>{{ item.name ?? item.productId }}</strong>
          <span class="qty">&times; {{ item.quantity }}</span>
        </div>
        <div class="line-right">
          <span>{{ formatPrice(item.lineTotal ?? 0) }}</span>
          <button class="link" :disabled="busy === item.productId" @click="removeItem(item.productId)">
            usun
          </button>
        </div>
      </article>
      <footer class="total">
        <span>Razem</span>
        <strong>{{ formatPrice(cart.total) }}</strong>
      </footer>
      <div class="actions">
        <button class="ghost-btn" :disabled="busy === 'clear'" @click="clearCart">wyczysc koszyk</button>
        <a class="primary" href="/checkout">Przejdz do platnosci &rarr;</a>
      </div>
    </section>

    <section v-else class="empty">
      <p>Koszyk jest pusty.</p>
      <a class="primary" href="/product">Zobacz katalog produktow</a>
    </section>

    <p class="hint">
      Ta strona odpytuje ten sam koefekt <code>ctx.get('cart')</code>, do ktorego pisala
      aplikacja <code>product</code> - inny proces zbudowany, inny fiber Cordis, ten sam
      obiekt w pamieci.
    </p>
  </main>
</template>

<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  background: radial-gradient(circle at top, #1b1230 0%, #0b0714 60%);
  color: #f1ecff;
  min-height: 100vh;
}
.shell { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
.badge {
  display: inline-block; font-size: .75rem; letter-spacing: .03em; text-transform: uppercase;
  color: #b79dff; background: rgba(139, 92, 246, .12); border: 1px solid rgba(139, 92, 246, .35);
  border-radius: 999px; padding: .3rem .8rem; margin-bottom: 1.25rem;
}
.top { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
h1 { font-size: 2rem; margin: 0; }
.ghost { color: #b79dff; text-decoration: none; font-size: .9rem; }
.list { margin-top: 2rem; border-top: 1px solid rgba(255,255,255,.08); }
.line {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 0; border-bottom: 1px solid rgba(255,255,255,.08);
}
.qty { color: #9c8fc4; margin-left: .5rem; font-size: .85rem; }
.line-right { display: flex; align-items: center; gap: .8rem; }
.link { background: none; border: none; color: #ff8a8a; cursor: pointer; font-size: .8rem; }
.total { display: flex; justify-content: space-between; padding: 1.2rem 0; font-size: 1.15rem; }
.actions { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.ghost-btn { background: none; border: 1px solid rgba(255,255,255,.18); color: #cabdf0; border-radius: .5rem; padding: .5rem .9rem; cursor: pointer; }
.primary {
  background: #7c4dff; color: white; text-decoration: none; border-radius: .5rem;
  padding: .6rem 1.1rem; font-size: .9rem; font-weight: 600;
}
.empty { padding: 3rem 0; text-align: center; color: #b8adda; display: flex; flex-direction: column; gap: 1rem; align-items: center; }
.hint { color: #9c8fc4; font-size: .82rem; border-top: 1px solid rgba(255,255,255,.08); padding-top: 1.5rem; margin-top: 2.5rem; }
.hint code { background: rgba(255,255,255,.08); padding: .1rem .35rem; border-radius: .3rem; }
</style>
