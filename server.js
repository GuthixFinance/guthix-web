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
// ── Pool TVL via Helius RPC ──
// Each Meteora DAMM v1 pool owns exactly two SPL token accounts (the reserve vaults).
// getTokenAccountsByOwner returns both, giving us live token balances = TVL for stablecoin pools.
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=6df6c556-796b-48f1-a24a-21ffe0995f66';

app.post('/api/rpc/pool-tvl', async (req, res) => {
  const { pools } = req.body; // array of pool addresses
  if (!Array.isArray(pools) || !pools.length) return res.status(400).json({ error: 'pools array required' });

  const results = {};
  await Promise.all(pools.map(async (poolAddr) => {
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          poolAddr,
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          { encoding: 'jsonParsed' }
        ]
      });
      const { status, body: rb } = await httpRequest(HELIUS_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
      });
      const data = JSON.parse(rb);
      const accounts = data?.result?.value ?? [];
      console.log(`[rpc] pool-tvl ${poolAddr.slice(0,8)}… found ${accounts.length} token accounts`);

      const vaults = accounts.map(a => ({
        pubkey: a.pubkey,
        mint:   a.account.data.parsed.info.mint,
        amount: parseFloat(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
      }));

      const tvl = vaults.reduce((s, v) => s + v.amount, 0); // stablecoin pools: amount ≈ USD
      results[poolAddr] = { vaults, tvl };
    } catch (err) {
      console.error(`[rpc] pool-tvl error for ${poolAddr}:`, err.message);
      results[poolAddr] = { vaults: [], tvl: null, error: err.message };
    }
  }));

  res.json(results);
});


// ── Single token account balance — for Manifest vault ──
// GET /api/rpc/token-balance — returns uiAmount for a known SPL token account address
app.post('/api/rpc/token-balance', async (req, res) => {
  const { account } = req.body;
  if (!account) return res.status(400).json({ error: 'account required' });
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getTokenAccountBalance',
      params: [account, { commitment: 'confirmed' }]
    });
    const { status, body: rb } = await httpRequest(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    const data = JSON.parse(rb);
    const amount = data?.result?.value?.uiAmount ?? null;
    console.log(`[rpc] token-balance ${account.slice(0,8)}… = ${amount}`);
    res.json({ account, amount });
  } catch (err) {
    console.error('[rpc] token-balance error:', err.message);
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

// ── Meteora DAMM v1 API — pool data (TVL, volume, fees) ──
// GET /api/meteora/pools/:address  → https://damm-api.meteora.ag/pools/:address
// Returns: { pool_tvl, trading_volume (24h), fee_volume (24h), pool_token_amounts,
//            pool_token_usd_amounts, pool_token_mints, trade_apy, ... }
app.get('/api/meteora/pools/:address', (req, res) => {
  proxy(
    `https://damm-api.meteora.ag/pools/${req.params.address}`,
    { headers: { Accept: 'application/json' } },
    res
  );
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
      const { status, body } = await httpRequest(
        `https://damm-api.meteora.ag/pools/${addr}`,
        { headers: { Accept: 'application/json' } }
      );
      const data = JSON.parse(body);
      if (status === 200 && data.pool_address) {
        results[addr] = data;
        console.log(`[meteora] pool ${addr.slice(0,8)}… TVL=$${data.pool_tvl} vol24h=$${data.trading_volume}`);
      } else {
        results[addr] = { error: `HTTP ${status}` };
      }
    } catch (err) {
      console.warn(`[meteora] pool ${addr.slice(0,8)}… error:`, err.message);
      results[addr] = { error: err.message };
    }
  }));
  res.json(results);
});

// ── Fallback ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GUTHIX running on port ${PORT}`);
  console.log(`Node ${process.version}`);
});
