/**
 * Liveness-only endpoint: zero zaleznosci od Cordis/Redis, dziala nawet gdy
 * `features`/`cart`/`redis` jeszcze/juz nie sa dostepne. `deploy/k8s/deployment.yaml`
 * uzywa tego (nie `/`) dla livenessProbe - `/` wymaga Redis (feature-gate.ts
 * odpytuje `isEnabled()` na kazdym requescie), wiec przy przejsciowej awarii
 * Redisa livenessProbe na `/` restartowaloby caly kontener bez powodu (proces
 * Node jest zdrowy, tylko downstream padl) - patrz ARCHITECTURE.md#shared-state.
 * readinessProbe zostaje na `/` celowo - TO ma odzwierciedlac cala zaleznosc.
 */
export default defineEventHandler(() => ({ status: 'ok' }))
