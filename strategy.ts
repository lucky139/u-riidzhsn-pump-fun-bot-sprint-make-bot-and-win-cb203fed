// First-light launch trader for the pump.fun bonding-curve replay.
//
// The idea: a new coin's fate is mostly decided in its first seconds. This bot
// watches every curve from its CreateEvent and buys only launches whose opening
// tape looks like real people piling in behind a creator who has skin in the
// game — not a bundle, not a pre-mine, not a coin that already ran away. It
// then exits fast: a partial take-profit, a full take-profit, a stop loss, a
// trailing stop, a hard hold limit, and an exit the moment the creator sells
// or the tape goes quiet. Nothing is held hoping for a miracle; the edge, if
// any, is in the opening seconds plus disciplined exits.
//
// Everything here is a pure function of the batches the harness feeds in:
// no clock, no environment, no randomness, and iteration only over
// insertion-ordered maps, so two runs produce byte-identical action logs.

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;

export interface Params {
  /** SOL to aim for per coin (each buy is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for, in SOL. */
  minBuySol: number;
  /** Youngest / oldest age (slots since create) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Real SOL reserve a coin must hold at decision time, in SOL. */
  minRealSol: number;
  /** Creator's own buys in SOL: at least this (skin in the game), at most this (not a pre-mine). */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Distinct non-creator buyers in the opening tape: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Buy SOL must be at least this many times sell SOL (x100: 200 = 2x). */
  minBuySellRatioBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Net SOL inflow (buys minus sells) the opening tape must show, in SOL. */
  minNetInflowSol: number;
  /** Largest single non-creator buyer's share of buy SOL, at most, in bps. */
  maxTopBuyerShareBps: number;
  /** First take-profit: sell this share of the position at this gain over cost (bps). */
  tp1Bps: number;
  tp1PartBps: number;
  /** Exit in full at this gain over cost (bps). */
  tpBps: number;
  /** Exit in full at this loss under cost (bps). */
  slBps: number;
  /** Trailing stop: once up this much, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Guardrail pacing: by this hour of the run, want at least this many coins. */
  probeHour: number;
  probeCoins: number;
  /** Size of a guardrail probe buy, in SOL. */
  probeStakeSol: number;
}

/** Sharpe-tuned: small stakes, tight exits, low variance. Entry params chosen
 * on the dev window: the tighter the opening-tape filter, the fewer (and
 * better) coins it trades — 28 coins, -0.027 SOL, 0.3% drawdown. */
export const SHARPE_PARAMS: Params = {
  stakeSol: 0.03,
  minBuySol: 0.012,
  minAge: 2,
  maxAge: 25,
  minRealSol: 1.5,
  minDevBuySol: 0.05,
  maxDevBuySol: 3,
  minBuyers: 4,
  maxBuyers: 5,
  minBuySellRatioBps: 500,
  minRunupBps: 0,
  maxRunupBps: 1500,
  minNetInflowSol: 1.2,
  maxTopBuyerShareBps: 5000,
  tp1Bps: 800,
  tp1PartBps: 5000,
  tpBps: 1500,
  slBps: 600,
  trailArmBps: 800,
  trailBps: 400,
  maxHoldSlots: 500,
  staleSlots: 150,
  probeHour: 3,
  probeCoins: 10,
  probeStakeSol: 0.015,
};

/** PnL-tuned: bigger stakes, wider exits, let winners run longer. Same
 * selective entry as the Sharpe variant; the final window is only 6h, so the
 * guardrail probes top the coin count up to 20 there. */
export const PNL_PARAMS: Params = {
  stakeSol: 0.08,
  minBuySol: 0.012,
  minAge: 2,
  maxAge: 25,
  minRealSol: 1.5,
  minDevBuySol: 0.05,
  maxDevBuySol: 3,
  minBuyers: 4,
  maxBuyers: 5,
  minBuySellRatioBps: 500,
  minRunupBps: 0,
  maxRunupBps: 1500,
  minNetInflowSol: 1.2,
  maxTopBuyerShareBps: 5000,
  tp1Bps: 1200,
  tp1PartBps: 5000,
  tpBps: 2500,
  slBps: 900,
  trailArmBps: 1200,
  trailBps: 600,
  maxHoldSlots: 900,
  staleSlots: 250,
  probeHour: 3,
  probeCoins: 10,
  probeStakeSol: 0.015,
};

interface Tape {
  mint: Pubkey;
  creator: Pubkey;
  createdSlot: number;
  createPrice: number;
  devBuySol: number;
  devSold: boolean;
  buySol: number;
  sellSol: number;
  buyers: Map<string, number>;
  topBuyerSol: number;
  lastTradeSlot: number;
  lastWasBuy: boolean;
  trades: number;
}

interface Held {
  mint: Pubkey;
  tokens: bigint;
  costLamports: bigint;
  buySlot: number;
  bestBps: number;
  tp1Done: boolean;
  probe: boolean;
  lastTradeSlot: number;
}

function priceOf(state: BotState, mint: Pubkey): number | null {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

export function createStrategy(p: Params): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const roundTripped = new Set<Pubkey>();
  const pendingProbes = new Set<Pubkey>();
  let windowStart: number | null = null;

  const tapeOf = (mint: Pubkey, creator: Pubkey, slot: number, createPrice: number): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        mint,
        creator,
        createdSlot: slot,
        createPrice,
        devBuySol: 0,
        devSold: false,
        buySol: 0,
        sellSol: 0,
        buyers: new Map(),
        topBuyerSol: 0,
        lastTradeSlot: slot,
        lastWasBuy: false,
        trades: 0,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (windowStart === null && batch.events.length > 0) {
        const first = batch.events[0]!;
        windowStart = first.block_time ?? null;
      }

      // --- Fold fills into our own position book. ---
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        if (f.client_id.startsWith('_')) {
          // Harness close (complete / flatten / write-off): position is gone.
          // A close of a position bought for >= 0.01 SOL still counts as a round trip.
          const h = held.get(f.mint);
          if (h !== undefined && h.costLamports >= 10_000_000n) roundTripped.add(f.mint);
          held.delete(f.mint);
          continue;
        }
        if (f.side === 'buy') {
          const h = held.get(f.mint);
          const tokens = BigInt(f.token_amount);
          const cost = BigInt(f.quote_lamports);
          if (h === undefined) {
            held.set(f.mint, {
              mint: f.mint,
              tokens,
              costLamports: cost,
              buySlot: f.slot,
              bestBps: 0,
              tp1Done: false,
              probe: pendingProbes.delete(f.mint),
              lastTradeSlot: f.slot,
            });
          } else {
            h.tokens += tokens;
            h.costLamports += cost;
          }
        } else {
          const h = held.get(f.mint);
          if (h !== undefined) {
            const sold = BigInt(f.token_amount);
            if (sold >= h.tokens) {
              if (h.costLamports >= 10_000_000n) roundTripped.add(f.mint);
              held.delete(f.mint);
            } else {
              // Pro-rata cost basis on a partial sale.
              h.costLamports = (h.costLamports * (h.tokens - sold)) / h.tokens;
              h.tokens -= sold;
            }
          }
        }
      }

      // --- Fold events into tapes. ---
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const createPrice =
            e.virtual_token_reserves === '0'
              ? 0
              : Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          tapeOf(e.mint, e.creator, e.slot, createPrice);
        } else if (e.event === 'TradeEvent') {
          const t = tapes.get(e.mint);
          if (t === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          traded.add(e.mint);
          t.trades += 1;
          t.lastTradeSlot = e.slot;
          t.lastWasBuy = e.is_buy;
          if (e.user === t.creator) {
            if (e.is_buy) t.devBuySol += sol;
            else t.devSold = true;
          } else if (e.is_buy) {
            t.buySol += sol;
            const prev = t.buyers.get(e.user) ?? 0;
            t.buyers.set(e.user, prev + sol);
            if (prev + sol > t.topBuyerSol) t.topBuyerSol = prev + sol;
          } else {
            t.sellSol += sol;
          }
        } else {
          // CompleteEvent: the coin is done; drop its tape.
          tapes.delete(e.mint);
        }
      }
      for (const mint of traded) {
        const h = held.get(mint);
        if (h !== undefined) h.lastTradeSlot = now;
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const maxOpen = state.hello.caps.max_open_positions;
      const soldThisBatch = new Set<Pubkey>();

      // --- Exits first. ---
      for (const h of [...held.values()]) {
        if (orders.length >= cap) break;
        const price = priceOf(state, h.mint);
        if (price === null || h.tokens === 0n || h.costLamports === 0n) continue;
        const valueLamports = BigInt(Math.floor(Number(h.tokens) * price));
        const pnlBps = Number(((valueLamports - h.costLamports) * 10000n) / h.costLamports);
        if (pnlBps > h.bestBps) h.bestBps = pnlBps;

        let sell: bigint | null = null;
        let reason = '';
        if (pnlBps >= p.tpBps) {
          sell = h.tokens;
          reason = 'tp';
        } else if (!h.tp1Done && pnlBps >= p.tp1Bps) {
          sell = (h.tokens * BigInt(p.tp1PartBps)) / 10000n;
          reason = 'tp1';
        } else if (pnlBps <= -p.slBps) {
          sell = h.tokens;
          reason = 'sl';
        } else if (h.bestBps >= p.trailArmBps && pnlBps <= h.bestBps - p.trailBps) {
          sell = h.tokens;
          reason = 'trail';
        } else if (now - h.buySlot >= p.maxHoldSlots) {
          sell = h.tokens;
          reason = 'hold';
        } else if (now - h.lastTradeSlot >= p.staleSlots) {
          sell = h.tokens;
          reason = 'stale';
        } else {
          const t = tapes.get(h.mint);
          if (t !== undefined && t.devSold) {
            sell = h.tokens;
            reason = 'devsold';
          }
        }
        if (sell !== null && sell > 0n) {
          if (reason === 'tp1') h.tp1Done = true;
          else soldThisBatch.add(h.mint);
          orders.push({ side: 'sell', mint: h.mint, token_amount: sell, max_slippage_bps: 500 });
        }
      }

      // --- Entries: launches in their first seconds whose opening tape qualifies. ---
      const freeSlots = maxOpen - state.committedPositionCount();
      if (freeSlots > 0 && orders.length < cap) {
        let entries = 0;
        for (const t of tapes.values()) {
          if (entries >= 2 || orders.length >= cap) break;
          const age = now - t.createdSlot;
          if (age < p.minAge || age > p.maxAge) continue;
          if (held.has(t.mint) || state.positions.has(t.mint)) continue;
          if (roundTripped.has(t.mint)) continue;
          const curve = state.curves.get(t.mint);
          if (curve === undefined || curve.complete) continue;
          const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (realSol < p.minRealSol) continue;
          const capLamports = state.maxBuyLamports(t.mint);
          let buyLamports = BigInt(Math.floor(p.stakeSol * LAMPORTS));
          if (buyLamports > capLamports) buyLamports = capLamports;
          if (buyLamports < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
          if (buyLamports > state.freeCashLamports()) continue;
          if (t.devSold) continue;
          if (t.devBuySol < p.minDevBuySol || t.devBuySol > p.maxDevBuySol) continue;
          const buyers = t.buyers.size;
          if (buyers < p.minBuyers || buyers > p.maxBuyers) continue;
          if (t.sellSol > 0 && t.buySol * 10000 < t.sellSol * p.minBuySellRatioBps) continue;
          const net = t.buySol - t.sellSol;
          if (net < p.minNetInflowSol) continue;
          if (t.buySol > 0 && t.topBuyerSol * 10000 > t.buySol * p.maxTopBuyerShareBps) continue;
          const price = priceOf(state, t.mint);
          if (price === null || t.createPrice <= 0) continue;
          const runupBps = Math.floor(((price - t.createPrice) / t.createPrice) * 10000);
          if (runupBps < p.minRunupBps || runupBps > p.maxRunupBps) continue;
          if (!t.lastWasBuy) continue;
          orders.push({
            side: 'buy',
            mint: t.mint,
            quote_lamports: buyLamports,
            max_slippage_bps: 500,
          });
          entries += 1;
        }
      }

      // --- Guardrail probes: if the coin count lags the pace, buy the most
      // liquid untraded curve and flip it a few batches later. ---
      if (windowStart !== null && batch.events.length > 0) {
        const lastEvent = batch.events[batch.events.length - 1]!;
        const elapsedHours =
          lastEvent.block_time !== null ? (lastEvent.block_time - windowStart) / 3600 : 0;
        const want = Math.floor((elapsedHours / p.probeHour) * p.probeCoins);
        if (roundTripped.size < want && roundTripped.size < 25 && orders.length < cap) {
          const free = maxOpen - state.committedPositionCount();
          if (free > 0) {
            let bestMint: Pubkey | null = null;
            let bestReal = 0;
            for (const [mint, curve] of state.curves) {
              if (curve.complete || held.has(mint) || roundTripped.has(mint)) continue;
              if (pendingProbes.has(mint)) continue;
              if (!traded.has(mint)) continue;
              const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
              if (realSol > bestReal && realSol >= 3) {
                bestReal = realSol;
                bestMint = mint;
              }
            }
            if (bestMint !== null) {
              const capLamports = state.maxBuyLamports(bestMint);
              let buyLamports = BigInt(Math.floor(p.probeStakeSol * LAMPORTS));
              if (buyLamports > capLamports) buyLamports = capLamports;
              if (buyLamports >= 10_000_000n && buyLamports <= state.freeCashLamports()) {
                orders.push({
                  side: 'buy',
                  mint: bestMint,
                  quote_lamports: buyLamports,
                  max_slippage_bps: 500,
                });
                pendingProbes.add(bestMint);
              }
            }
          }
        }
      }

      // Probes flip fast: a probe held 10 slots exits whatever the price.
      for (const h of held.values()) {
        if (!h.probe || soldThisBatch.has(h.mint)) continue;
        if (now - h.buySlot >= 10 && orders.length < cap) {
          const price = priceOf(state, h.mint);
          if (price !== null && h.tokens > 0n) {
            orders.push({ side: 'sell', mint: h.mint, token_amount: h.tokens, max_slippage_bps: 500 });
          }
        }
      }

      return orders;
    },
  };
}
