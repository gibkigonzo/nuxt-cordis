<script setup lang="ts">
useHead({ title: 'Sklep Cordis' })
</script>

<template>
  <main class="shell">
    <header class="hero">
      <p class="badge">apps/home &middot; port 3000 &middot; niezalezny fiber Cordis</p>
      <h1>Sklep zbudowany jako modularny monolit runtime</h1>
      <p class="lede">
        Trzy (docelowo cztery) niezalezne aplikacje Nuxt, kazda zbudowana i wdrazana
        osobno, dziala w JEDNYM procesie Node orkiestrowanym przez
        <a href="https://github.com/cordiverse/cordis" target="_blank" rel="noreferrer">Cordis</a>.
        Komunikuja sie przez wspoldzielone koefekty (<code>cart</code>, <code>product</code>) -
        bez zadnego narzutu sieciowego miedzy nimi.
      </p>
    </header>

    <nav class="grid">
      <a class="card" href="/product">
        <span class="card-title">Katalog produktow</span>
        <span class="card-sub">apps/product &middot; port 3001 &middot; inject: cart, product</span>
      </a>
      <a class="card" href="/cart">
        <span class="card-title">Koszyk</span>
        <span class="card-sub">apps/cart &middot; port 3002 &middot; inject: cart</span>
      </a>
    </nav>

    <section class="note">
      <h2>Jak to dziala</h2>
      <ul>
        <li>Kazda aplikacja jest budowana Nitro-presetem <code>node-listener</code> do jednego pliku JS.</li>
        <li><code>@shop/nuxt-wrapper</code> importuje ten plik i otwiera wlasny <code>http.Server</code> - odwrotnoscia jest <code>server.close()</code>.</li>
        <li>Broker (ta brama) kieruje ruch po prefiksie sciezki, czytajac reaktywna tabele tras.</li>
        <li>Zmiana kodu jednej aplikacji przeladowuje wylacznie jej fiber (HMR) - pozostale dzialaja dalej.</li>
      </ul>
    </section>
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
.shell { max-width: 880px; margin: 0 auto; padding: 4rem 1.5rem 5rem; }
.badge {
  display: inline-block;
  font-size: .75rem;
  letter-spacing: .03em;
  text-transform: uppercase;
  color: #b79dff;
  background: rgba(139, 92, 246, .12);
  border: 1px solid rgba(139, 92, 246, .35);
  border-radius: 999px;
  padding: .3rem .8rem;
  margin-bottom: 1.25rem;
}
h1 { font-size: 2.4rem; line-height: 1.15; margin: 0 0 1rem; }
.lede { color: #cabdf0; line-height: 1.6; max-width: 60ch; }
.lede a { color: #b79dff; }
.lede code { background: rgba(255,255,255,.08); padding: .1rem .35rem; border-radius: .3rem; }
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
