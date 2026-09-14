<script setup lang="ts">
useHead({ title: 'Sklep Cordis' })
</script>

<template>
  <main class="shell">
    <header class="hero">
      <p class="badge">modul @shop/module-home &middot; jedna appka apps/shop</p>
      <h1>Sklep zbudowany jako modularny monolit runtime</h1>
      <p class="lede">
        Strony (home/product/cart) sa teraz Nuxt Modulami skladanymi w JEDNA
        aplikacje podczas builda (<code>modules/*</code>) - jeden proces, jeden
        port, natywny router Nuxta. Warstwa, ktora nadal jest "modularnym
        monolitem runtime", to uslugi backendowe: koszyk i katalog to
        wspoldzielone koefekty <a href="https://github.com/cordiverse/cordis" target="_blank" rel="noreferrer">Cordis</a>
        (<code>cart</code>, <code>product</code>) - bez zadnego narzutu
        sieciowego miedzy stronami, ktore z nich korzystaja.
      </p>
    </header>

    <nav class="grid">
      <NuxtLink class="card" to="/product">
        <span class="card-title">Katalog produktow</span>
        <span class="card-sub">@shop/module-product &middot; inject: cart, product</span>
      </NuxtLink>
      <NuxtLink class="card" to="/cart">
        <span class="card-title">Koszyk</span>
        <span class="card-sub">@shop/module-cart &middot; inject: cart</span>
      </NuxtLink>
    </nav>

    <section class="note">
      <h2>Jak to dziala</h2>
      <ul>
        <li>Kazdy modul rejestruje wlasne strony/route'y serwerowe podczas builda apps/shop (defineNuxtModule).</li>
        <li>Orchestrator laduje JEDEN zbudowany plik (<code>.output/server/index.mjs</code>) przez <code>@shop/nuxt-wrapper</code>.</li>
        <li>Koefekt <code>features</code> (Cordis) pamieta, ktore moduly sa aktualnie wlaczone - da sie to przelaczac bez rebuildu.</li>
        <li>Zmiana kodu przebudowuje CALA appke (jeden build) - to swiadomy kompromis, patrz ARCHITECTURE.md#10.</li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
h1 { font-size: 2.4rem; line-height: 1.15; margin: 0 0 1rem; }
.lede { color: #cabdf0; line-height: 1.6; max-width: 60ch; }
.lede a { color: #b79dff; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 2.5rem 0; }
.card {
  display: flex; flex-direction: column; gap: .35rem;
  padding: 1.4rem 1.5rem; border-radius: 1rem;
  background: rgba(255,255,255,.04);
  border: 1px solid rgba(255,255,255,.08);
  text-decoration: none; color: inherit;
  transition: transform .15s ease, border-color .15s ease;
}
.card:hover { transform: translateY(-2px); border-color: rgba(139, 92, 246, .5); }
.card-title { font-size: 1.15rem; font-weight: 600; }
.card-sub { font-size: .8rem; color: #9c8fc4; }
.note { border-top: 1px solid rgba(255,255,255,.08); padding-top: 2rem; }
.note h2 { font-size: 1.1rem; color: #d9cfff; }
.note ul { color: #b8adda; line-height: 1.8; padding-left: 1.2rem; }
.note code { background: rgba(255,255,255,.08); padding: .1rem .35rem; border-radius: .3rem; }
</style>
