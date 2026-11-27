// Pump.fun Bot Sprint — Make Bot and Win.
// First-light launch trader: buys only launches whose opening tape shows real
// buyers behind a creator with skin in the game, then exits fast on a partial
// take-profit, a full take-profit, a stop loss, a trailing stop, a hold limit,
// a creator sell, or a quiet tape. Tuned for net PnL: bigger stakes, wider exits.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, PNL_PARAMS } from './strategy.ts';

await runBot(createStrategy(PNL_PARAMS));
