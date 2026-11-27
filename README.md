# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/lucky139/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/lucky139/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

First-light launch trader for the pump.fun bonding-curve replay. It watches every curve from its CreateEvent and buys only launches whose opening tape shows real buyers behind a creator with skin in the game — 4–5 distinct non-creator buyers, buys at least 5× sells, net inflow over 1.2 SOL, creator bought 0.05–3 SOL and hasn't sold, run-up under 15%. Then it exits fast: partial take-profit at +12%, full take-profit at +25%, stop loss at −9%, trailing stop, a 900-slot hold limit, exit on creator sell or a quiet tape. Guardrail probes top the coin count up to 20 when natural entries lag the pace.

Tuned for net PnL: 0.08 SOL stakes, wider exits, winners run longer. On the dev window: −0.020 SOL (−0.20%), 27 coins, 27 round trips, 0.2% max drawdown, guardrails met.

## Run it

```sh
node main.ts
```

`main.ts` hands `createStrategy(PNL_PARAMS)` to the vendored `vendor/makefun-bot.ts` shim (byte-identical copy of the kit SDK). The strategy is deterministic: no clock, no environment, no randomness — two runs produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=es7k9fg6&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
