# pi-kimi-keepalive

Prompt-cache keepalive for [Kimi](https://www.kimi.com/) (`kimi-coding` provider) sessions in the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

While you think, eat, or sit in a meeting, Kimi's automatic prompt cache quietly expires (~5 minutes, observed, not contractual). Coming back means re-reading your *entire* conversation at full input price. This extension replays your last real provider request — conversation untouched — as a tiny background probe on an interval, so the cached prefix keeps its freshness and your session resumes at cache-read prices.

**The probe never enters your session.** No synthetic user messages, no synthetic turns, no context pollution. Only aggregate statistics (hits / misses / estimated savings) are surfaced.

[中文文档](README.zh-CN.md)

## Why replay instead of a synthetic message?

| Approach | Keeps cache warm | pollutes session | Notes |
| --- | --- | --- | --- |
| Manually send a tiny prompt every 5 min | ✅ | ✅ real messages | what you'd do by hand |
| [pi-idle-time](https://github.com/clankercode/pi-idle-time) | ✅ | ✅ real turns | sends `[cache keepalive] {time}` user messages; the model replies; context grows forever |
| [pi-warm-cache](https://github.com/ribbons-digital/pi-warm-cache) | ✅ | ❌ | fail-closed design: only works for routes registered as `anthropic-messages` **with** `cacheControlFormat === "anthropic"`; the `kimi-coding` route doesn't qualify, so it silently does nothing |
| **pi-kimi-keepalive** | ✅ | ❌ | replays the captured payload byte-identical for the prefix; guardrails included |

## How it works

1. **Capture (read-only).** The `before_provider_headers` and `before_provider_request` hooks snapshot the headers and a `structuredClone` of the last real request to `kimi-coding` (`…/v1/messages`, Anthropic-compatible). Nothing is written to disk.
2. **Replay.** While the agent is idle, the captured request is POSTed to `{baseUrl}/v1/messages` with only *terminal* parameters changed — `stream` removed, `thinking` removed, `max_tokens` clamped (default 16), and `tool_choice: {type:"none"}` added (dropped once, with a retry, if the endpoint rejects it). `system` / `messages` / `tools` — everything inside the provider's automatic prefix cache key — stay byte-identical, so the request lands in the same cached prefix and restarts its TTL at cache-read pricing.
3. **Observe.** The response usage is parsed (Anthropic-style `cache_read_input_tokens`, OpenAI-style `cached_tokens` as fallback) to classify each probe as a hit or a miss. Nothing else is retained.

Headers are forwarded verbatim except hop-by-hop/length headers (`content-length`, `host`, `connection`, …), which `fetch` manages itself.

## Guardrails

- **Busy-safe** — probes are skipped while the agent is working; `agent_settled` re-arms the timer.
- **`maxIdle`** (default 30 min) — stops probing entirely after the configured idle runway. No burning quota overnight.
- **Miss pause** — 2 consecutive probes that don't hit the prefix cache pause the loop until your next real turn.
- **Error pause** — 3 consecutive failures, or any HTTP 401/403, pause probing until the next real request recaptures credentials.
- **Spend cap** — session probe spending is estimated in USD and pauses at the ceiling (default $1.00; `cap=0` removes it).
- **Timers are `unref`'d** — pending probes never keep the process alive.

A single fresh real provider request automatically clears any sticky pause (it refreshes credentials and warms the cache by itself).

## Install

```sh
pi install npm:pi-kimi-keepalive
```

Or run straight from a checkout:

```bash
git clone https://github.com/oliverlyu/pi-kimi-keepalive
pi -e ./pi-kimi-keepalive/src/index.ts
```

Requires Node ≥ 20 and a Pi build exposing the `before_provider_headers` / `before_provider_request` hooks (pi ≥ 0.84).

## Usage

```
/keepalive                  status
/keepalive on|off           enable / disable (persisted in ~/.pi/cache-keepalive/state.json)
/keepalive now              one manual probe
/keepalive resume           clear a sticky pause
/keepalive interval=4m      probe cadence (≥ 30s)
/keepalive maxidle=30m      probe cutoff after this idle time (0 = off)
/keepalive cap=1.0          session probe-spend ceiling in USD (0 = none)
/keepalive token=512        minimum cached prompt size for miss detection
/keepalive maxoutput=16     probe max_tokens clamp
/keepalive reset            zero the session stats
```

Defaults (tuned against Kimi's observed ~5 min cache TTL):

| Setting | Default | Meaning |
| --- | --- | --- |
| `interval` | `4m` | probe cadence; 5 min TTL minus margin |
| `maxidle` | `30m` | stop probing after this idle stretch (`0` = never) |
| `token` | `512` | small responses below this input size can't be judged misses |
| `maxoutput` | `16` | probe `max_tokens` clamp |
| `cap` | `$1.00` | per-session probe spend ceiling (`0` = unlimited) |

`on`/`interval`/`maxidle`/`cap`/… persist to `~/.pi/cache-keepalive/state.json`; hit/miss statistics are per-session. Set `PI_KEEPALIVE_DEBUG=1` for verbose stderr logging.

## Cost model

Kimi 3 prices (per 1M tokens): input $3 · output $15 · **cache read $0.3**.

- A probe that **hits** pays ~cache-read price for your whole prefix: 50k tokens ≈ **$0.015**, 200k ≈ **$0.06**.
- A probe that **misses** pays full input price for the same prefix — that's why misses pause the loop after 2 attempts.
- The measured "savings" counter assumes a probe hit replaces a *cold* resume that would have re-read the prefix at full price; it is an estimate, useful for comparing against simply letting the cache die on sessions you will resume.
- If you're on a Kimi subscription (kimi-coding OAuth), billing is quota-based and the USD figures are only a reference point.

Ten probes an hour on a 100k-token session ≈ $0.30/h while idle — cheaper than one cold resume of that context, and it only runs while you're actually away. Tune `maxidle` and `cap` to taste.

## Caveats

- Kimi's prompt-cache TTL (~5 min) and pricing are **observed behavior, not API contract**. This is a guardrailed experiment, not a savings promise — the `saved` figure is an estimate, not a refund.
- Targets the `kimi-coding` provider with `anthropic-messages` API routes only. Other providers need different capture/probe logic and are out of scope.
- The probe runs entirely inside your machine against `https://` endpoints only. Captured payloads/headers live only in process memory.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests run on Node's native TypeScript stripping (Node ≥ 22.18 / 24) with a stubbed `fetch` and a temp `$HOME` — no network, no real API keys.

## FAQ

**Why replay instead of sending a tiny synthetic "keepalive" message?** A synthetic message is still a real model turn: it bills as a new conversation prefix (cache *write* at best), and every message lands in your session history forever. Replaying the captured payload keeps the prefix byte-identical to the real session, so the provider's automatic prefix cache treats it as the same conversation; nothing enters your Pi session.

**Why not support every provider?** Generic cache-keeping needs per-provider capture/probe logic (different cache-key semantics, OpenAI-style vs Anthropic-style). pi-warm-cache already covers registered anthropic-style routes; this extension intentionally scopes to what it can verify: `kimi-coding`.

**Does a probe use my subscription quota?** Yes — like your manual 5-minute message, the probe itself is a real request billed by Kimi's rules (here at cache-read prices). Guardrails exist precisely to bound that spend.

## License

MIT — see [LICENSE](LICENSE).