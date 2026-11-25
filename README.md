# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/krida268/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/krida268/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for pump.fun bonding curves that optimises for the hourly Sharpe ratio, not raw PnL. It buys only hot, mature curves: real SOL reserves of at least 15 SOL (only a small share of curves ever get there), at least 300 slots old, and still rising at least +5% over the last 300 slots. Each entry is a fixed 0.05 SOL, one entry per mint ever, and exits are take-profit +25%, stop-loss -8%, or a ~8-minute time stop — deliberately with no trailing stop, which sold the spikes too early on the dev window. A pace guard relaxes the reserve bar to 10 SOL if round trips fall behind one per 6,000 slots, so the 20-mint guardrail stays reachable on a quiet window. Fully deterministic: every decision is a pure function of the replay batches, so the two grading runs produce identical action logs.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: it reads `hello` / `batch` / `done` JSON lines and answers each batch with one reply of orders. No dependencies, no network, no configuration. Node 22 or later.

---

<sub>Entered on [make.fun](https://make.fun/?ref=enzt809f&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
