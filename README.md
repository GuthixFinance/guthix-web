# GUTHIX App — Deploy to Railway

**Live at:** https://guthix-production.up.railway.app

---

## Local dev

```bash
npm install
npm start
# open http://localhost:3000/swap.html
```

## Deploy to Railway

**First time:**
```bash
railway login
railway init
railway up
```

**Subsequent deploys:**
```bash
railway up
```

Or via GitHub: railway.app → New Project → Deploy from GitHub repo → Railway auto-detects Node.

---

## File structure

```
public/
  index.html        ← landing page        (at /)
  swap.html         ← swap UI             (at /swap.html)
  litepaper.md      ← litepaper           (at /litepaper.md)
server.js           ← Express static server + API proxy routes
package.json
```

---

## API proxy routes (server.js)

All external API calls are proxied through the server to avoid CORS and hide credentials.

| Route | Upstream | Purpose |
|-------|----------|---------|
| `GET /api/jupiter/quote` | `lite-api.jup.ag/swap/v1/quote` | Swap quotes (NAV rate + live quotes) |
| `POST /api/jupiter/swap` | `lite-api.jup.ag/swap/v1/swap` | Build swap transaction |
| `POST /api/rpc/pool-tvl` | Helius RPC (`getTokenAccountsByOwner`) | Live TVL for Meteora DAMM v1 pool reserve vaults |
| `POST /api/rpc/token-balance` | Helius RPC (`getTokenAccountBalance`) | Single SPL token account balance (Manifest vault) |
| `POST /api/rpc/token-supply` | Helius RPC (`getTokenSupply`) | sgxUSD circulating supply |
| `GET /api/dexscreener/token-pairs/v1/solana/:mint` | DexScreener | All pairs for sgxUSD mint (price, volume, liquidity) |
| `GET /api/dexscreener/pairs/solana/:address` | DexScreener | Single pair data by pool address (Manifest CLOB) |

> **Note:** `quote-api.jup.ag` DNS is unreachable from Railway us-west1. Use `lite-api.jup.ag` only.

---

## Live addresses (Solana mainnet)

| | Address |
|---|---|
| **sgxUSD mint** | `sgx1cN3SJTtobeXPcCvYa4kc85HVsKQLa7mQhsXma9n` |
| **sgxUSD/USDT pool** (0.05%, DAMM v1) | `6c2DTHtCtS4YJ3cJYJNvj7qY9QQ8bqoUjGBZEgf9m889` |
| **sgxUSD/sUSDe pool** (0.10%, DAMM v1) | `6FGtEcUT3UcJeU993oNKBYuYg1Uj9NeXNDzcpsobhxwy` |
| **sgxUSD/syrupUSDC pool** (0.10%, DAMM v1) | `3SjZNbuyzL5tow1LXf7mHYutnWdpboq97Z1RSfwpoVcT` |
| **Manifest CLOB market** (0%, limit orders) | `Cud6C8uE39bzNkHjQ9VZTkovuzjTcy5496s6neHoLvbo` |
| **Manifest sgxUSD vault account** | `ALGCuBDd7SLJsJyA8k9NPhjfduBMnAgZoYMUUjuR2x7v` |
| **Helius RPC** | `https://mainnet.helius-rpc.com/?api-key=6df6c556-796b-48f1-a24a-21ffe0995f66` |

All three Meteora pools are **DAMM v1 ("Dynamic Pool · Stable · Permissionless")** — not DLMM.

---

## Pool data sources

| Data | Source | Method |
|------|--------|--------|
| TVL (Meteora pools) | Helius RPC | `getTokenAccountsByOwner` on pool address — sums both reserve vaults |
| TVL (Manifest vault) | Helius RPC | `getTokenAccountBalance` on `ALGCuBDd7SLJsJyA8k9NPhjfduBMnAgZoYMUUjuR2x7v` |
| Volume 24h | DexScreener | `volume.h24` from token-pairs endpoint |
| Fee APR | Derived | `(fee24h × 365 / tvl) × 100` |
| sgxUSD supply | Helius RPC | `getTokenSupply` on sgxUSD mint |

> DexScreener volume shows "Unavailable" until pools are indexed. Self-resolves as swap activity accumulates.

---

## Polling intervals (swap.html)

| Function | Interval | Notes |
|----------|----------|-------|
| `fetchNavRate` | 30s | Jupiter quote: 1 USDC → sgxUSD |
| `fetchDexScreener` | 30s | Price, volume, liquidity |
| `fetchPoolAPR` | 60s | Re-derives APR from cached state; no HTTP |
| `fetchPoolTVL` | 120s | Helius RPC for all 4 venues |
| `fetchTokenSupply` | 120s | Helius RPC for circulating supply |

---

## Current status

| Item | Status |
|------|--------|
| Swap UI | ✅ Live on mainnet |
| sgxUSD/USDT pool | ✅ Live — Meteora DAMM v1 |
| sgxUSD/sUSDe pool | ✅ Live — Meteora DAMM v1 |
| sgxUSD/syrupUSDC pool | ✅ Live — Meteora DAMM v1 |
| Manifest CLOB market | ✅ Live — ~95K sgxUSD |
| Jupiter routing | ✅ Confirmed |
| `guthix-core` vault program | 🔜 Q3 2026 — pending audit (OtterSec / Neodyme) |
| USDY, bridge hub pools | 🔜 Full launch Q3 2026 |
| Wormhole NTT (Base) | 🔜 Q4 2026 |
| Custom domain `app.guthix.finance` | 🔜 CNAME → Railway not yet configured |

---

## Links

- App: https://guthix-production.up.railway.app/swap.html
- X: https://x.com/GuthixFinance
- GitHub: https://github.com/GuthixFinance
