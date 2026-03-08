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
// ── Meteora DAMM v1 — amm-v2.meteora.ag ──
// Our pools are DAMM v1 "Dynamic Pool · Stable". Correct host: amm-v2.meteora.ag
// Response fields: pool_tvl, trading_volume (24h), fee_volume (24h), weekly_trading_volume, weekly_fee_volume
app.get('/api/meteora/pool/:address', async (req, res) => {
  const addr = req.params.address;
  const url = `https://amm-v2.meteora.ag/pools/${addr}`;
  try {
    console.log('[proxy] Meteora DAMM v1 -->', url);
    const { status, body } = await httpRequest(url, { headers: { Accept: 'application/json' } });
    console.log('[proxy] Meteora DAMM v1 <--', status, body.slice(0, 200));
    if (!body || body.trim() === '') return res.status(502).json({ error: 'Empty response' });
    let data;
    try { data = JSON.parse(body); } catch (_) { return res.status(502).json({ error: 'Bad JSON' }); }
    if (status === 200 && data && !data.error) return res.status(200).json(data);
    res.status(status).json(data || { error: 'Meteora error' });
  } catch (err) {
    console.error('[proxy] Meteora DAMM v1 error', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── DexScreener — token-pairs (used by fetchDexScreener) ──
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

// ── Fallback ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GUTHIX running on port ${PORT}`);
  console.log(`Node ${process.version}`);
});
