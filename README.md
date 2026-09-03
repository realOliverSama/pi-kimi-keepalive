# pi-kimi-keepalive

Prompt-cache keepalive for [Kimi](https://www.kimi.com/) (`kimi-coding` provider) sessions in the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Kimi's automatic prompt cache nominally expires after ~5 minutes of idle, but real-world testing shows the live TTL runs longer — probes as far apart as 8 minutes still hit reliably. Once the cache does expire, the next request re-reads the full context at full input price. This extension captures the last real provider request and replays it on a fixed interval while the session is idle, so the cached prefix stays warm and subsequent requests are billed at cache-read rates.

Replayed requests are sent directly to the provider endpoint. They do not pass through the Pi session pipeline: no synthetic messages, no model turns, no changes to conversation history. Only aggregate statistics are surfaced.

[中文文档](README.zh-CN.md)

## Requirements

- Node ≥ 20, pi ≥ 0.84 (exposes the `before_provider_headers` / `before_provider_request` hooks)
- `kimi-coding` provider (OAuth subscription recommended), `kimi-openai-completions` API

## Install

```bash
git clone https://github.com/realoliversama/pi-kimi-keepalive
pi install /path/to/pi-kimi-keepalive
```

For a single session without installing:

```bash
pi -e /path/to/pi-kimi-keepalive/src/index.ts
```

After the package is published to npm: `pi install npm:pi-kimi-keepalive`.

## Setup

On the first start with no `~/.pi/cache-keepalive/state.json` present and an interactive UI, the extension runs a setup wizard that configures the five settings below. Leaving a prompt empty or pressing Esc keeps the default. The wizard can be rerun with `/keepalive setup`; in headless sessions it is skipped and defaults are kept.

| Step | Setting | Command | Default | Description |
| --- | --- | --- | --- | --- |
| 1 | Max idle cutoff | `maxidle` | `30m` | Probing stops after this much idle time; `0` disables the cutoff. |
| 2 | Miss pause threshold | `miss` | `1` | Pause after N consecutive probes that do not hit the prompt cache. A hit resets the count. Applies in `default` mode. |
| 3 | Error circuit breaker | `errors` | `3` | Pause after N consecutive probe failures (network errors, HTTP 5xx). HTTP 401/403 always pauses immediately. |
| 4 | Session spend cap | `cap` | `$1.00` | Ceiling on estimated USD probe spend per session; `0` removes the cap. |
| 5 | Probing mode | `mode` | `default` | `default` keeps the fixed cadence; `smart` self-tunes it (below). |

The wizard ends with a prompt to enable keepalive. Probing starts after the next real turn, which provides the captured request.

## Probing modes

Two modes share the same guardrails; they differ in how the cadence is chosen.

**`default` (the starting mode)** — the cadence is fixed at whatever `interval=` says, **8 minutes** by default. Real-world testing shows probes at this cadence reliably hit the prefix cache (the effective TTL runs longer than the ~5-minute nominal one), so the default cadence already works as the always-warm heartbeat: every probe renews the cache at cache-read rates (~1/10 of full input price) until `maxidle` cuts the loop off.

If the cache does expire underneath it (server-side eviction, TTL change), the mode self-heals instead of giving up: the missed probe itself rebuilds the cache entry with the same prefix, so the cadence drops to the **5-minute safe floor** (inside the nominal TTL), probing continues, and the next probe renews the entry. Only a miss **at** the 5-minute floor counts toward the `miss` pause threshold — a cache that cannot even be rebuilt at 5m is an environment problem, and the default `miss=1` stops probing there. The back-off is persisted; `/keepalive interval=8m` returns to the original cadence.

**`smart` (`/keepalive mode=smart`)** — self-tunes the cadence toward the real cache TTL instead of guessing it:

1. Starts at **8 minutes**.
2. After **3 consecutive hits** the cadence is confirmed and the value grows by **+30s**. Only confirmed values are persisted, so `~/.pi/cache-keepalive/state.json` always holds the largest cadence with observed consecutive hits.
3. A **miss** immediately parks probing: the cadence steps back **30s** to the last confirmed value (never below the 8m floor), the value is persisted, and probing stays **stopped**. A fresh real turn does **not** resume it — only re-selecting smart mode (`/keepalive mode=smart`) continues from the parked cadence.
4. **Context guard:** growth only happens while the last probe saw ≤ **200k prompt tokens**; the first probe above that immediately reverts the cadence to the 8m floor and keeps it there (a missed probe on a 200k+ context is too expensive to risk).
5. Guardrails (`maxidle`, `cap`, `errors`, HTTP 401/403) still apply while smart is probing.

Per learn cycle the spend is minimal: 3 cache-read probes confirm a step, and one full-price probe ends the cycle — the parked cadence keeps every future session at the highest value the cache has proven to hold.

## Commands

```
/keepalive                  status
/keepalive setup            rerun the setup wizard
/keepalive on|off           enable / disable (persisted)
/keepalive now              one manual probe (bypasses pauses)
/keepalive resume           clear a sticky pause
/keepalive mode=smart       adaptive cadence (8m floor; +30s per 3-hit confirmation; a miss parks probing, mode=smart resumes)
/keepalive mode=default     fixed cadence (the interval= value)
/keepalive interval=4m45s   probe cadence in default mode (≥ 30s; default 8m reliably hits the cache in practice)
/keepalive maxidle=30m      idle cutoff (0 = disabled)
/keepalive miss=1           pause after N consecutive cache misses
/keepalive errors=3         pause after N consecutive probe failures
/keepalive cap=1.0          session probe-spend ceiling in USD (0 = none)
/keepalive token=512        minimum prompt size for miss classification
/keepalive maxoutput=16     probe max_tokens clamp
/keepalive reset            zero the session stats
```

All settings persist to `~/.pi/cache-keepalive/state.json`. Statistics are per-session.

## How it works

1. **Capture.** The `before_provider_request` hook snapshots a `structuredClone` of the payload of each real `kimi-coding` request. In-memory only; nothing is written to disk.
2. **Replay.** While the agent is idle and enabled, the captured request is POSTed to `{baseUrl}/chat/completions` (kimi-openai-completions) with only terminal parameters changed:

   | Change | Reason |
   | --- | --- |
   | remove `stream` / `stream_options` | returns usage as a single JSON body |
   | remove `thinking` | avoids thinking-budget constraints against the output clamp below |
   | remove `store` | probe output is unused; no need to persist it |
   | `max_completion_tokens: 16` | bounds the probe's output cost |
   | HTTP 400 retry | drops `prompt_cache_retention` (a terminal parameter, not part of the prefix) |

   `messages`, `tools`, and Kimi's `prompt_cache_key` / `prompt_cache_retention` are kept byte-identical — the inputs to the provider's prefix-cache key — so the replay matches the existing cache entry and restarts its TTL at cache-read pricing. Verified live: a probe against a 48k-token session reports `use.prompt_tokens_details.cached_tokens × 48,116 / 48,116`.
3. **Authentication.** pi injects the OAuth bearer token after the `before_provider_headers` hook fires, so captured headers usually lack auth. Probes read the current `kimi-coding.access` token from pi's auth store (`~/.pi/agent/auth.json`) at probe time, staying in sync with pi's token refreshes.
4. **Classification.** Response usage (`prompt_tokens_details.cached_tokens`, falling back to Anthropic-style fields) classifies each probe as a hit or a miss. The response is otherwise discarded.

Captured headers are merged in minus hop-by-hop and length headers; the bearer token always comes from the auth store.

## Guardrails

- Probes are skipped while a turn is running; the timer rearms on `agent_settled`.
- `maxIdle` cutoff stops probing during extended idle periods.
- `miss` / `errors` streaks and HTTP 401/403 pause probing until the next real turn recaptures credentials and resets state.
- Session probe spend is estimated from model pricing and pauses at the cap.
- Timers are `unref()`'d and never keep the process alive.
- All pauses are cleared automatically by the next real provider request.

## Cost accounting

Kimi K3 list prices (USD per 1M tokens): input 3, output 15, cache read 0.3, cache write 0.

- A probe that hits the prefix cache costs approximately the cache-read price of the full context: ~$0.015 at 50k tokens, ~$0.03 at 100k, ~$0.06 at 200k.
- A probe that misses re-reads the prefix at full input price. Consecutive misses pause the loop (threshold: `miss`).
- The `saved` counter estimates `cacheReadTokens × (input − cacheRead) / 1M` — what an equivalent cold resume would have cost at full input price.

On a Kimi subscription, billing is quota-based and USD figures are indicative only.

## Limitations

- The nominal ~5-minute TTL, the longer effective TTL observed in practice, and the pricing above are observed behavior, not an API contract. The `saved` estimate is informational, not a guaranteed saving.
- Only the `kimi-coding` provider (`kimi-openai-completions` API, with an `anthropic-messages` fallback) is supported. Other providers have different cache-key semantics and are out of scope.
- Captured payloads and headers live only in process memory; probes are sent only to `https://` endpoints.

## Development

```bash
npm install
npm run typecheck
npm test          # 26 tests; stubbed fetch, temp $HOME, no network
```

Tests run on Node's native TypeScript stripping (Node ≥ 22.18 / 24).

## License

MIT — see [LICENSE](LICENSE).