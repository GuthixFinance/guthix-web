/**
 * rpc-credits.js — Helius credit meter with a hard monthly cap.
 *
 * NAMING: this is about RPC provider credits. It is NOT the `credits` table elsewhere in the
 * fleet, which is the depositor sgxUSD ledger. Different concept, same unfortunate word —
 * hence the `rpc_` prefix on the table and the `rpc-` prefix on this file.
 *
 * Why it exists: this service leaked its Helius API key in a PUBLIC repo and in the JS it
 * served to every visitor, and burned ~845k of a 1M/month plan before anyone noticed — because
 * unlike tx-indexer and control-panel, nothing here was ever counted. The fleet meter looked
 * healthy the whole time. A meter is only as complete as the set of repos you thought to
 * instrument; this closes the last one.
 *
 * Ported from guthix-control-panel/rpc-credits.js, which mirrors tx-indexer/src/credits.ts —
 * patch all three together. Same three properties:
 *   1. PERSISTED, so a restarting container cannot hand itself a fresh budget.
 *   2. ADDITIVE flushes, so instances sharing a key share one budget.
 *   3. DEGRADE (fall back to the public endpoint), never throw.
 */

let pool = null;
let service = 'guthix-web';
let budget = 0;

const monthKey = (d = new Date()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

const DDL = `
CREATE TABLE IF NOT EXISTS rpc_credits (
  service    TEXT NOT NULL,
  month      TEXT NOT NULL,
  credits    BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service, month)
);`;

const FLUSH_CREDITS = 250;
const FLUSH_MS = 60_000;
const THRESHOLDS = [50, 80, 95];

let month = monthKey();
let spent = 0;      // authoritative total for `month`, including other instances
let pending = 0;    // charged locally, not yet flushed
let lastFlush = 0;
let fired = new Set();
let ready = false;
let warnedExhausted = false;

const pct = () => (budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 0);

function logEvent(type, payload) {
  if (!pool) return;
  pool
    .query('INSERT INTO events (service, type, payload) VALUES ($1,$2,$3)', [
      service, type, JSON.stringify(payload),
    ])
    .catch(() => { /* drop — telemetry must never break the caller */ });
}

/** Wire up the meter. `dbPool` is the shared-Postgres pool; null disables metering entirely. */
async function initRpcCredits(dbPool, opts = {}) {
  pool = dbPool;
  service = opts.service || service;
  budget = Number(opts.budget || 0);
  if (!pool) {
    // DELIBERATE DIVERGENCE from the control-panel/tx-indexer copies: they return here with
    // ready=false, which makes charge() a no-op — so a service with an unreachable database
    // spends with no meter and no cap at all. That is precisely how this one drained the
    // account unnoticed. Losing PERSISTENCE is acceptable; losing the CAP is not. So we run
    // in-process: the total resets on restart, but the budget still binds while we are up.
    ready = true;
    lastFlush = Date.now();
    setInterval(() => { /* nothing to flush */ }, FLUSH_MS).unref();
    console.warn(
      '[rpc-credits] no DB pool — spend is capped in-process only'
      + (budget > 0 ? ` (${budget.toLocaleString()}/mo)` : '')
      + ', and the running total resets on restart',
    );
    return;
  }
  try {
    await pool.query(DDL);
    const { rows } = await pool.query(
      'SELECT credits FROM rpc_credits WHERE service=$1 AND month=$2', [service, month],
    );
    spent = rows[0] ? Number(rows[0].credits) : 0;
    lastFlush = Date.now();
    ready = true;

  // A periodic flush, because the FLUSH_MS check in charge() can only fire ON a charge — so a
  // service that goes quiet (a cache TTL passes with no visitors) holds its last
  // batch in memory indefinitely and loses it on restart. unref() so this never keeps a
  // --once process alive.
    setInterval(() => { if (pending > 0) void flush(); }, FLUSH_MS).unref();
    // Re-arm thresholds already crossed before this restart, so a bouncing container does not
    // re-page for 50% on every boot.
    if (budget > 0) for (const t of THRESHOLDS) if (spent >= (budget * t) / 100) fired.add(t);
    console.log(
      `[rpc-credits] ${service} ${month}: ${spent.toLocaleString()} spent`
      + (budget > 0 ? ` / ${budget.toLocaleString()} budget (${pct()}%)` : ' (no budget set — metering only)'),
    );
  } catch (e) {
    console.warn(`[rpc-credits] init failed — spend will NOT be capped: ${e.message}`);
  }
}

let inFlight = null;

/**
 * Serialise flushes. Without this, a size-triggered flush fired by charge() runs detached, and
 * a later `await flushRpcCredits()` sees pending===0 and returns while that write is still in
 * the air — so a shutdown flush can return before the credits it was meant to save are saved.
 * Found by the meter's own test, which read the DB back and got the pre-flush total.
 */
async function flush() {
  if (inFlight) await inFlight.catch(() => {});
  if (!pool || !ready || pending <= 0) return; // no pool = in-process only, nothing to persist
  inFlight = doFlush();
  try { await inFlight; } finally { inFlight = null; }
}

async function doFlush() {
  const delta = pending;
  pending = 0;
  lastFlush = Date.now();
  try {
    const { rows } = await pool.query(
      `INSERT INTO rpc_credits (service, month, credits, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (service, month) DO UPDATE
           SET credits = rpc_credits.credits + EXCLUDED.credits, updated_at = now()
       RETURNING credits`,
      [service, month, delta],
    );
    if (rows[0]) spent = Number(rows[0].credits);
  } catch (e) {
    // Put it back. Under-reporting spend is the dangerous direction to be wrong in.
    pending += delta;
    console.warn(`[rpc-credits] flush failed (will retry): ${e.message}`);
  }
  checkThresholds();
}

function checkThresholds() {
  if (budget <= 0) return;
  for (const t of THRESHOLDS) {
    if (fired.has(t) || spent < (budget * t) / 100) continue;
    fired.add(t);
    console.warn(`[rpc-credits] ${service} at ${pct()}% of its ${month} Helius budget (${spent.toLocaleString()}/${budget.toLocaleString()})`);
    logEvent('rpc_budget', { service, month, threshold_pct: t, spent, budget, pct: pct() });
  }
}

/** Record `n` credits. Cheap and synchronous — the DB write is batched. */
function charge(n, method) {
  if (!ready || !(n > 0)) return;
  if (monthKey() !== month) {
    void flush();
    month = monthKey();
    spent = 0;
    fired = new Set();
    warnedExhausted = false;
    console.log(`[rpc-credits] month rollover → ${month}, budget reset`);
  }
  pending += n;
  spent += n; // optimistic: the cap must bind between flushes, not only after one
  // Always check here rather than only on the non-flush path: with no DB pool flush() is a
  // no-op that never reaches checkThresholds(), so the alerts would go silent exactly when
  // the meter is least able to tell you anything. checkThresholds() is idempotent per level.
  checkThresholds();
  if (pending >= FLUSH_CREDITS || Date.now() - lastFlush >= FLUSH_MS) void flush();
  if (process.env.HELIUS_CREDIT_DEBUG === 'true') console.log(`[rpc-credits] +${n} (${method}) → ${spent}`);
}

/** True once this month's budget is gone — callers must fall back to the public endpoint. */
function budgetExhausted() {
  if (budget <= 0) return false; // 0 = metering only, no cap
  const over = spent >= budget;
  if (over && !warnedExhausted) {
    warnedExhausted = true;
    console.warn(
      `[rpc-credits] ${service} has spent its entire ${month} Helius budget `
      + `(${spent.toLocaleString()}/${budget.toLocaleString()}) — falling back to the public RPC `
      + 'for the rest of the month. The site keeps working; it just gets slower and flakier.',
    );
    logEvent('rpc_budget_exhausted', { service, month, spent, budget });
  }
  return over;
}

function creditState() { return { service, month, spent, budget, pct: pct() }; }

module.exports = { initRpcCredits, charge, budgetExhausted, creditState, flushRpcCredits: flush };
