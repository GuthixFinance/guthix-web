// Load .env if present, so the RPC key lives in a gitignored file rather than in an export
// you have to remember. Optional: a host that injects real environment variables (Railway,
// Render, Docker) needs no .env, and a fork without the dependency still boots.
try { require('dotenv').config(); } catch { /* no dotenv installed — env vars only */ }

const express = require('express');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CORS for proxy routes ──
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Low-level HTTP helper (no external deps, works on any Node version) ──
function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url      = new URL(urlStr);
    const lib      = url.protocol === 'https:' ? https : http;
    const reqOpts  = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };

    const req = lib.request(reqOpts, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function proxy(urlStr, options, res) {
  try {
    console.log('[proxy] -->', options.method || 'GET', urlStr);
    const { status, body } = await httpRequest(urlStr, options);
    console.log('[proxy] <--', status, urlStr.slice(0, 80));
    let data;
    try { data = JSON.parse(body); } catch (_) { data = { raw: body.slice(0, 200) }; }
    res.status(status).json(data);
  } catch (err) {
    console.error('[proxy] ERROR', err.message, urlStr.slice(0, 80));
    res.status(502).json({ error: err.message });
  }
}

// ── Quote — Jupiter Lite (strips free-tier-unsupported params) ──
app.get('/api/jupiter/quote', async (req, res) => {
  // Remove params not supported on Jupiter Lite free tier
  const allowed = ['inputMint','outputMint','amount','slippageBps','onlyDirectRoutes','swapMode','asLegacyTransaction'];
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(req.query).filter(([k]) => allowed.includes(k)))
  ).toString();
  const urls = [
    `https://lite-api.jup.ag/swap/v1/quote?${qs}`,
    `https://quote-api.jup.ag/v6/quote?${qs}`,
  ];
  let lastData = null;
  let lastStatus = 502;
  for (const url of urls) {
    try {
      console.log('[proxy] Quote attempt:', url.slice(0, 100));
      const { status, body } = await httpRequest(url, { headers: { Accept: 'application/json' } });
      console.log('[proxy] Quote response:', status, body.slice(0, 120));
      let data;
      try { data = JSON.parse(body); } catch (_) { data = { raw: body.slice(0, 200) }; }
      if (status === 200 && data.outAmount) {
        return res.status(200).json(data);
      }
      lastData   = data;
      lastStatus = status;
      console.warn('[proxy] Quote not usable:', status, JSON.stringify(data).slice(0, 120));
    } catch (err) {
      console.warn('[proxy] Quote error:', err.message);
    }
  }
  res.status(lastStatus || 502).json(lastData || { error: 'No route found' });
});

// ── Swap — Jupiter Lite ──
app.post('/api/jupiter/swap', async (req, res) => {
  const swapBody = JSON.stringify({
    quoteResponse:           req.body.quoteResponse,
    userPublicKey:           req.body.userPublicKey,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 150000,
    wrapAndUnwrapSol:        req.body.wrapAndUnwrapSol ?? true,
  });
  const urls = [
    'https://lite-api.jup.ag/swap/v1/swap',
    'https://quote-api.jup.ag/v6/swap',
  ];
  let lastData = null;
  for (const url of urls) {
    try {
      console.log('[proxy] Swap attempt:', url);
      const { status, body: rb } = await httpRequest(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(swapBody) },
        body:    swapBody,
      });
      let data;
      try { data = JSON.parse(rb); } catch (_) { data = { raw: rb.slice(0, 200) }; }
      console.log('[proxy] Swap response:', status, JSON.stringify(data).slice(0, 100));
      if (status === 200 && data.swapTransaction) {
        return res.status(200).json(data);
      }
      lastData = data;
      console.warn('[proxy] Swap not usable from', url, '- trying next');
    } catch (err) {
      console.warn('[proxy] Swap error from', url, err.message);
    }
  }
  res.status(502).json(lastData || { error: 'All swap endpoints failed' });
});
// ── Helius credit meter ──────────────────────────────────────────────────────
// Metering is not optional bookkeeping here. The key that used to be hardcoded below was
// readable in this public repo and in the JS served to every visitor; it burned ~845k of a
// 1M/month plan before anyone noticed, because this was the one service in the fleet with no
// meter. Spend now lands in the same shared `rpc_credits` table as the rest of the fleet.
let creditsPool = null;
try {
  const { Pool } = require('pg');
  const EVENTS_DATABASE_URL = process.env.EVENTS_DATABASE_URL || '';
  if (EVENTS_DATABASE_URL) {
    creditsPool = new Pool({
      connectionString: EVENTS_DATABASE_URL,
      ssl: process.env.EVENTS_DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
      max: 2,
    });
  } else {
    console.warn('[rpc-credits] EVENTS_DATABASE_URL not set — Helius spend is capped in-process only');
  }
} catch (err) {
  // `pg` is optional: a fork running this repo without a database should still boot.
  console.warn('[rpc-credits] pg unavailable — Helius spend will NOT be metered:', err.message);
}
const { initRpcCredits, charge: chargeRpcCredits, budgetExhausted, creditState } = require('./rpc-credits.js');
const HELIUS_MONTHLY_CREDIT_BUDGET = Number(process.env.HELIUS_MONTHLY_CREDIT_BUDGET || 200_000);

// ── Pool TVL via RPC ──
// Each Meteora DAMM v1 pool owns exactly two SPL token accounts (the reserve vaults).
// getTokenAccountsByOwner returns both, giving us live token balances = TVL for stablecoin pools.
//
// The endpoint comes from the environment and NOTHING ELSE. This constant used to hold a
// literal Helius URL with the API key inline — in a PUBLIC repo, and echoed into
// public/swap.html so every visitor's browser received it too. A key belongs in the
// environment, on the server, metered: never in a repo, and never sent to a browser.
const HELIUS_RPC     = process.env.HELIUS_RPC_URL || '';
const PUBLIC_RPC_URL = process.env.PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';
if (!HELIUS_RPC) {
  console.warn('[rpc] HELIUS_RPC_URL not set — all RPC goes to the public endpoint (slower, flakier)');
}

/**
 * The endpoint to actually use right now. A credential is not a routing instruction, and
 * neither is a budget — once the month's credits are gone we route to the public endpoint
 * rather than into a wall.
 */
function activeRpcUrl() {
  if (!HELIUS_RPC) return PUBLIC_RPC_URL;
  return budgetExhausted() ? PUBLIC_RPC_URL : HELIUS_RPC;
}

// Charge weighting, matching the fleet's credits.ts: the getProgramAccounts family is billed
// far above a plain read, and getTokenAccountsByOwner — which /api/rpc/pool-tvl calls on every
// cache miss — is in it. Counting it as 1 would under-report the largest single cost here.
const GPA_FAMILY = new Set([
  'getProgramAccounts', 'getParsedProgramAccounts',
  'getTokenAccountsByOwner', 'getParsedTokenAccountsByOwner',
  'getTokenLargestAccounts',
]);
const creditsFor = (method) => (GPA_FAMILY.has(method) ? 10 : 1);

/**
 * Single choke point for every JSON-RPC call this service makes. Everything goes through here
 * so that metering is a property of making a call, not of remembering to wrap one.
 */
async function rpcCall(method, params) {
  const url  = activeRpcUrl();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  // Charge only what the metered endpoint actually served — calls that went to the public
  // endpoint are free and must not inflate the meter, or the cap binds early forever.
  if (url === HELIUS_RPC) chargeRpcCredits(creditsFor(method), method);
  const { body: rb } = await httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  const data = JSON.parse(rb);
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

// These routes are hit by every visitor's poll loop on the public Markets tab (no auth, no
// per-visitor limit), and they previously had NO cache at all — N concurrent visitors meant N
// paid calls. Cache server-side so they cost one call per TTL window regardless of traffic.
// TVL and supply move on the order of minutes, so 10min costs nothing visible.
const RPC_CACHE_MS = 600_000;
const rpcCache = new Map(); // key -> { at, data }
function cached(key, ttl, fn) {
  const hit = rpcCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
  return fn().then(data => { rpcCache.set(key, { at: Date.now(), data }); return data; });
}

// Addresses these public, unauthenticated routes are allowed to ask about. Without this they
// are an open RPC relay: anyone can point them at any account on Solana and spend our credits
// at will, from any origin, forever. An endpoint that costs money must never accept an
// arbitrary target from the internet.
const PUBLIC_RPC_ALLOWLIST = new Set([
  '6c2DTHtCtS4YJ3cJYJNvj7qY9QQ8bqoUjGBZEgf9m889', // Meteora sgxUSD/USDT
  '6FGtEcUT3UcJeU993oNKBYuYg1Uj9NeXNDzcpsobhxwy', // Meteora sgxUSD/sUSDe
  '3SjZNbuyzL5tow1LXf7mHYutnWdpboq97Z1RSfwpoVcT', // Meteora sgxUSD/syrupUSDC
  'ALGCuBDd7SLJsJyA8k9NPhjfduBMnAgZoYMUUjuR2x7v', // Manifest market sgxUSD vault
  'sgx1cN3SJTtobeXPcCvYa4kc85HVsKQLa7mQhsXma9n',  // sgxUSD mint (token supply)
  ...(process.env.PUBLIC_RPC_EXTRA_ADDRESSES || '').split(',').map(s => s.trim()).filter(Boolean),
]);

app.post('/api/rpc/pool-tvl', async (req, res) => {
  const { pools } = req.body; // array of pool addresses
  if (!Array.isArray(pools) || !pools.length) return res.status(400).json({ error: 'pools array required' });
  const disallowed = pools.filter(p => !PUBLIC_RPC_ALLOWLIST.has(p));
  if (disallowed.length) return res.status(403).json({ error: 'address not allowed', disallowed });

  const results = {};
  await Promise.all(pools.map(async (poolAddr) => {
    try {
      results[poolAddr] = await cached(`pool-tvl:${poolAddr}`, RPC_CACHE_MS, async () => {
        const result = await rpcCall('getTokenAccountsByOwner', [
          poolAddr,
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          { encoding: 'jsonParsed' },
        ]);
        const accounts = result?.value ?? [];
        console.log(`[rpc] pool-tvl ${poolAddr.slice(0,8)}… found ${accounts.length} token accounts (fresh)`);

        const vaults = accounts.map(a => ({
          pubkey: a.pubkey,
          mint:   a.account.data.parsed.info.mint,
          amount: parseFloat(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
        }));

        const tvl = vaults.reduce((s, v) => s + v.amount, 0); // stablecoin pools: amount ≈ USD
        return { vaults, tvl };
      });
    } catch (err) {
      console.error(`[rpc] pool-tvl error for ${poolAddr}:`, err.message);
      results[poolAddr] = { vaults: [], tvl: null, error: err.message };
    }
  }));

  res.json(results);
});


// ── Single token account balance — for Manifest vault ──
// POST /api/rpc/token-balance — returns uiAmount for a known SPL token account address
app.post('/api/rpc/token-balance', async (req, res) => {
  const { account } = req.body;
  if (!account) return res.status(400).json({ error: 'account required' });
  if (!PUBLIC_RPC_ALLOWLIST.has(account)) return res.status(403).json({ error: 'address not allowed' });
  try {
    const amount = await cached(`token-balance:${account}`, RPC_CACHE_MS, async () => {
      const result = await rpcCall('getTokenAccountBalance', [account, { commitment: 'confirmed' }]);
      console.log(`[rpc] token-balance ${account.slice(0,8)}… = ${result?.value?.uiAmount ?? null} (fresh)`);
      return result?.value?.uiAmount ?? null;
    });
    res.json({ account, amount });
  } catch (err) {
    console.error('[rpc] token-balance error:', err.message);
    res.status(502).json({ error: err.message });
  }
});


// ── Token supply (vault capacity) ──
// This is the call the browser used to make DIRECTLY to Helius, every 120s, per visitor, with
// the API key inline (public/swap.html's fetchTokenSupply). It is a server route now so the
// page needs no key and N visitors cost one call per TTL window instead of N.
app.post('/api/rpc/token-supply', async (req, res) => {
  const { mint } = req.body;
  if (!mint) return res.status(400).json({ error: 'mint required' });
  if (!PUBLIC_RPC_ALLOWLIST.has(mint)) return res.status(403).json({ error: 'address not allowed' });
  try {
    const supply = await cached(`token-supply:${mint}`, RPC_CACHE_MS, async () => {
      const result = await rpcCall('getTokenSupply', [mint, { commitment: 'confirmed' }]);
      console.log(`[rpc] token-supply ${mint.slice(0,8)}… = ${result?.value?.uiAmount ?? null} (fresh)`);
      return result?.value?.uiAmount ?? null;
    });
    res.json({ mint, supply });
  } catch (err) {
    console.error('[rpc] token-supply error:', err.message);
    res.status(502).json({ error: err.message });
  }
});


app.get('/api/dexscreener/token-pairs/v1/solana/:mint', (req, res) => {
  proxy(
    `https://api.dexscreener.com/token-pairs/v1/solana/${req.params.mint}`,
    { headers: { Accept: 'application/json' } },
    res
  );
});

// ── DexScreener — single pair (used by fetchManifestMarketData) ──
app.get('/api/dexscreener/pairs/solana/:address', (req, res) => {
  proxy(
    `https://api.dexscreener.com/latest/dex/pairs/solana/${req.params.address}`,
    { headers: { Accept: 'application/json' } },
    res
  );
});

// ── TEST ENDPOINT ──
app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Meteora DAMM v1 API — pool data (TVL, volume, fees) ──
// The damm-api expects the list endpoint with ?address= filter; the singular
// /pools/:address form rejects with "missing field `page`".
async function fetchMeteoraPool(addr) {
  const { status, body } = await httpRequest(
    `https://damm-api.meteora.ag/pools?page=0&size=10&address=${addr}`,
    { headers: { Accept: 'application/json' } }
  );
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const arr = JSON.parse(body);
  const p = Array.isArray(arr) ? arr.find(x => x.pool_address === addr) : null;
  if (!p) throw new Error('pool not found');
  return {
    address: addr,
    name:    p.pool_name,
    tvl:     parseFloat(p.pool_tvl ?? 0),
    vol:     parseFloat(p.trading_volume ?? 0),
    fee24h:  parseFloat(p.fee_volume ?? 0),
    apr:     parseFloat(p.apr ?? 0),
  };
}

app.get('/api/meteora/pools/:address', async (req, res) => {
  try {
    res.json(await fetchMeteoraPool(req.params.address));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Batch: POST { addresses: [...] } → fetch all in parallel, return keyed by address
app.post('/api/meteora/pools-batch', async (req, res) => {
  const { addresses } = req.body;
  if (!Array.isArray(addresses) || !addresses.length) {
    return res.status(400).json({ error: 'addresses array required' });
  }
  const results = {};
  await Promise.all(addresses.map(async (addr) => {
    try {
      const d = await fetchMeteoraPool(addr);
      results[addr] = d;
      console.log(`[meteora] ${addr.slice(0,8)}… TVL=$${d.tvl.toFixed(2)} vol24h=$${d.vol.toFixed(2)}`);
    } catch (err) {
      console.warn(`[meteora] ${addr.slice(0,8)}… error:`, err.message);
      results[addr] = { error: err.message };
    }
  }));
  res.json(results);
});

// Spend for the current month, so this is answerable from an instrument rather than from a
// billing page — which is exactly how the ~845k burn went unnoticed for weeks.
// MUST stay above the SPA catch-all below, or it is served index.html instead of JSON.
app.get('/api/rpc-credits', (req, res) => {
  res.json({ ...creditState(), endpoint: activeRpcUrl() === HELIUS_RPC ? 'helius' : 'public' });
});

// ── Fallback ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GUTHIX running on port ${PORT}`);
  console.log(`Node ${process.version}`);
  try {
    console.log(
      `[rpc] primary=${new URL(activeRpcUrl()).host}`
      + ` fallback=${new URL(PUBLIC_RPC_URL).host}`
      + ` budget=${HELIUS_MONTHLY_CREDIT_BUDGET.toLocaleString()}/mo`,
    );
  } catch { /* unparseable URL — the warning at startup already covers it */ }
  // Meter before serving: a request handled before the meter is ready is spend we never see.
  initRpcCredits(creditsPool, { service: 'guthix-web', budget: HELIUS_MONTHLY_CREDIT_BUDGET });
});
