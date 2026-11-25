// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins
//
// Paper-trading bot for the agent-fun/replay/v2 harness. The ranking metric is
// the HOURLY SHARPE RATIO on a 6-hour forward window, not raw PnL, so this bot
// optimises for many small, low-variance, positively-skewed round trips instead
// of one lucky moonshot: selective entries, fixed small size, tight exits.
//
// How the wire works (see vendor/makefun-bot.ts, the kit's own SDK shim):
// - The hello handshake arrives first and tells us the capital (10 SOL), the
//   caps (max 5 open positions, buys per mint per reply capped at 100 bps of
//   the mint's real SOL reserve, at most 16 orders per reply) and the fees.
// - Then one batch arrives per slot-step, carrying that slot's events, marks
//   for held mints, fills since the previous batch, and the account. We answer
//   each batch with exactly one reply holding this batch's orders.
// - Slot latency is 2: orders decided on slot s fill at slot s + 2, so the
//   price can move between decision and fill. We size conservatively and cap
//   slippage at 500 bps so a fast-moving curve cannot fill us far from the
//   price we decided on.
// - The run is executed twice and both action logs must match byte for byte,
//   so every decision here is a pure function of the hello + batches seen so
//   far: no clock, no environment, no Math.random anywhere.
//
// Strategy, in one paragraph. On the dev window every early-momentum variant
// lost money: fresh curves are mostly bundled launches that dump, and buying
// after a +5% rise means buying the top. What survived the sweep was the
// opposite end of the market: HOT, MATURE curves. We buy only a curve whose
// real SOL reserves are at least 15 SOL (it has real, sustained buying behind
// it — only ~8% of curves ever get there), that is at least 300 slots old,
// and whose price is still rising (+5% or more over the last 300 slots, so we
// ride an intact uptrend instead of catching a falling knife). Each buy is a
// fixed 0.05 SOL (capped by the per-mint reserve cap, never below 0.012 SOL,
// so every round trip clears the 0.01 SOL guardrail). We exit on take-profit
// +25%, stop-loss -8%, or a 1200-slot (~8 minute) time stop — and deliberately
// use NO trailing stop: on the dev window the trailing stop sold the spikes
// too early and cut the winners that pay for the losers. One entry per mint,
// ever. A pace guard relaxes the reserve bar to 10 SOL if round trips fall
// behind one per 6000 slots, so the 20-mint guardrail stays reachable even
// on a quiet final window.
//
// Dev-window calibration (offline sweep over the kit's 24 h dev data, then
// confirmed with grade-local): the early-momentum draft lost -0.38 SOL at
// Sharpe -1.04; this hot-mature version is near breakeven with a win rate
// around 37% and max drawdown under 2%. The final window is a fresh 6-hour
// sample, so no dev number is a promise — but the shape (small size, short
// holds, many coins, no single-coin dominance) is exactly what hourly
// Sharpe rewards.

import { runBot, type BotState, type Batch, type OrderInput } from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning
// All thresholds are plain constants, chosen by sweeping the dev window.
const BUY_SIZE_LAMPORTS = 50_000_000n; // 0.05 SOL per entry
const MIN_BUY_LAMPORTS = 12_000_000n; // never buy below this (guardrail is 0.01 SOL)
const MAX_OPEN = 5; // hello.caps.max_open_positions
const MIN_REAL_SOL_LAMPORTS = 15_000_000_000n; // 15 SOL of real reserves: a hot curve
const RELAXED_REAL_SOL_LAMPORTS = 10_000_000_000n; // pace-guard fallback: 10 SOL
const MIN_AGE_SLOTS = 300; // at least ~2 minutes old, and a 300-slot lookback exists
const LOOKBACK_SLOTS = 300; // recent-rise window
const MIN_RECENT_RISE_BPS = 500; // +5% over the last 300 slots
const TAKE_PROFIT_BPS = 2500; // +25% vs entry cost per token
const STOP_LOSS_BPS = -800; // -8% vs entry cost per token
const MAX_HOLD_SLOTS = 1200; // ~8 minute time stop
const MAX_SLIPPAGE_BPS = 500;
const SCALE = 1_000_000_000_000_000_000n; // fixed-point scale for price math.
// NOTE: token reserves carry 6 decimals (virtual_token_reserves ~1.073e15),
// so a lamports-per-token price is ~2.8e-5: a 1e4 scale rounds it to ZERO.
// 1e18 keeps full precision (a 1e4 scale was the bug that made the first
// grade-local run trade nothing at all).
const PACE_SLOTS = 6000; // one round trip per this many slots is the pace bar
const PACE_WARMUP_SLOTS = 30000; // do not judge the pace before this many slots

// ------------------------------------------------------------------ per-mint bookkeeping
interface MintState {
  createdSlot: number;
  /** (slot, scaled price) samples, pruned to the recent lookback + margin. */
  hist: Array<[number, bigint]>;
  realQuote: bigint;
  entrySlot: number; // -1 when flat / never entered
  entryCostLamports: bigint;
}

const mints = new Map<string, MintState>();
const pendingSell = new Set<string>(); // mints with a sell already in flight
let firstSlot = -1;
let roundTripsDone = 0;

// Price of a curve from its virtual reserves: quote per token, scaled by SCALE.
function priceOf(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n || virtualQuote <= 0n) return 0n;
  return (virtualQuote * SCALE) / virtualToken;
}

// Signed bps move from `from` to `to`, both scaled prices.
function moveBps(from: bigint, to: bigint): bigint {
  if (from <= 0n) return 0n;
  return ((to - from) * 10_000n) / from;
}

// Price of a mint `slots` ago, from its pruned history (0n when unknown).
function priceAgo(m: MintState, slot: number, slots: number): bigint {
  const target = slot - slots;
  let best = 0n;
  for (const [s, p] of m.hist) {
    if (s <= target) best = p;
    else break;
  }
  return best;
}

// ------------------------------------------------------------------ strategy
function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const slot = state.slot;
  if (firstSlot < 0) firstSlot = slot;

  // 1. Fold this batch's events into per-mint state.
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      if (!mints.has(e.mint)) {
        mints.set(e.mint, {
          createdSlot: e.slot,
          hist: [[e.slot, priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves))]],
          realQuote: 0n,
          entrySlot: -1,
          entryCostLamports: 0n,
        });
      }
    } else if (e.event === "TradeEvent") {
      const m = mints.get(e.mint);
      if (m === undefined) continue; // curve created before the window; ignore
      const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      m.hist.push([e.slot, p]);
      m.realQuote = BigInt(e.real_quote_reserves);
      // Prune samples older than the lookback plus a small margin.
      while (m.hist.length > 2 && m.hist[0][0] < slot - LOOKBACK_SLOTS - 60) m.hist.shift();
    } else {
      // CompleteEvent: the curve migrated; any position is closed by the
      // harness. Forget the mint so we never try to trade it again.
      mints.delete(e.mint);
      pendingSell.delete(e.mint);
    }
  }

  // 2. Count round trips that closed in this batch, and clear their sells.
  for (const f of batch.fills) {
    if (f.side === "sell") {
      pendingSell.delete(f.mint);
      if (!f.client_id.startsWith("_")) roundTripsDone += 1;
    }
  }

  // 3. Exits first: manage every open position before opening new ones.
  for (const [mint, holding] of state.positions) {
    const m = mints.get(mint);
    if (m === undefined || pendingSell.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0n) continue;

    // Entry cost per token from the account (fees included), scaled.
    const costPerToken = (holding.cost_lamports * SCALE) / holding.token_amount;
    if (m.entrySlot < 0) {
      // Position arrived without our entry record (e.g. a fill reported a
      // batch late): anchor the entry at the known cost and current slot.
      m.entrySlot = slot;
      m.entryCostLamports = holding.cost_lamports;
    }

    const ret = moveBps(costPerToken, price);
    const heldSlots = slot - m.entrySlot;
    const shouldExit =
      ret >= BigInt(TAKE_PROFIT_BPS) ||
      ret <= BigInt(STOP_LOSS_BPS) ||
      heldSlots >= MAX_HOLD_SLOTS;
    if (shouldExit) {
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingSell.add(mint);
    }
  }

  // 4. Entries: hot, mature curves still rising. One buy per mint, ever.
  // Pace guard: if round trips lag one per PACE_SLOTS, lower the reserve bar
  // so the 20-mint guardrail stays reachable on a quiet window.
  const elapsed = slot - firstSlot;
  const paceOk = elapsed < PACE_WARMUP_SLOTS || roundTripsDone + state.positions.size >= Math.floor(elapsed / PACE_SLOTS);
  const minReal = paceOk ? MIN_REAL_SOL_LAMPORTS : RELAXED_REAL_SOL_LAMPORTS;

  if (state.committedPositionCount() < MAX_OPEN) {
    for (const [mint, m] of mints) {
      if (orders.length >= 8) break; // keep replies small; 16 is the hard cap
      if (state.committedPositionCount() + orders.filter((o) => o.side === "buy").length >= MAX_OPEN) break;
      if (m.entrySlot >= 0) continue; // already traded this mint once
      if (state.positions.has(mint) || pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const age = slot - m.createdSlot;
      if (age < MIN_AGE_SLOTS) continue;
      // Real, sustained buying: at least minReal SOL actually in the curve.
      if (m.realQuote < minReal) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0n) continue;
      // Still rising: +5% or more over the last 300 slots.
      const old = priceAgo(m, slot, LOOKBACK_SLOTS);
      if (old <= 0n) continue;
      if (moveBps(old, price) < BigInt(MIN_RECENT_RISE_BPS)) continue;
      // Respect the per-mint reserve cap: buys in one reply may spend at
      // most 100 bps of the mint's real SOL reserve.
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const size = BUY_SIZE_LAMPORTS < cap ? BUY_SIZE_LAMPORTS : cap;
      if (size < MIN_BUY_LAMPORTS) continue;
      // Cash check: the buy plus its tx fee must fit in free cash.
      if (state.freeCashLamports() - state.txFeeLamports() < size) continue;
      orders.push({
        side: "buy",
        mint,
        quote_lamports: size,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      // Mark the entry now; the fill confirms the cost, but the slot anchor
      // keeps the exit logic deterministic either way.
      m.entrySlot = slot;
      m.entryCostLamports = size;
    }
  }

  // 5. Housekeeping: forget stale mint state so the map stays small.
  if (mints.size > 4000) {
    for (const [mint, m] of mints) {
      if (m.entrySlot < 0 && slot - m.createdSlot > MAX_HOLD_SLOTS * 8 && !state.positions.has(mint)) {
        mints.delete(mint);
      }
    }
  }

  return orders;
}

await runBot({
  onHello(_state) {
    // Nothing to precompute: the hello handshake already told us the caps,
    // fees and latency, and all strategy state is built from the batches.
  },
  onBatch,
  onDone(state, done) {
    console.error(
      `done: reason=${done.reason} cash=${state.cash} positions=${state.positions.size} mints_seen=${mints.size} round_trips=${roundTripsDone}`,
    );
  },
});
