# pi-kimi-keepalive

Prompt-cache keepalive for [Kimi](https://www.kimi.com/) (`kimi-coding` provider) sessions in the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Kimi's automatic prompt cache has an observed TTL of ~5 minutes. Once it expires, the next request re-reads the full context at full input price. This extension captures the last real provider request and replays it on a fixed interval while the session is idle, so the cached prefix stays warm and subsequent requests are billed at cache-read rates.

Replayed requests are sent directly to the provider endpoint. They do not pass through the Pi session pipeline: no synthetic messages, no model turns, no changes to conversation history. Only aggregate statistics are surfaced.

[中文文档](README.zh-CN.md)

## Requirements

- Node ≥ 20, pi ≥ 0.84 (exposes the `before_provider_headers` / `before_provider_request` hooks)
- `kimi-coding` provider (OAuth or API key), `anthropic-messages` API

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

On the first start with no `~/.pi/cache-keepalive/state.json` present and an interactive UI, the extension runs a setup wizard that configures the four guardrails below. Leaving a prompt empty or pressing Esc keeps the default. The wizard can be rerun with `/keepalive setup`; in headless sessions it is skipped and defaults are kept.

| Step | Setting | Command | Default | Description |
| --- | --- | --- | --- | --- |
| 1 | Max idle cutoff | `maxidle` | `30m` | Probing stops after this much idle time; `0` disables the cutoff. |
| 2 | Miss pause threshold | `miss` | `2` | Pause after N consecutive probes that do not hit the prompt cache. A hit resets the count. |
| 3 | Error circuit breaker | `errors` | `3` | Pause after N consecutive probe failures (network errors, HTTP 5xx). HTTP 401/403 always pauses immediately. |
| 4 | Session spend cap | `cap` | `$1.00` | Ceiling on estimated USD probe spend per session; `0` removes the cap. |

The wizard ends with a prompt to enable keepalive. Probing starts after the next real turn, which provides the captured request.

## Commands

```
/keepalive                  status
/keepalive setup            rerun the setup wizard
/keepalive on|off           enable / disable (persisted)
/keepalive now              one manual probe (bypasses pauses)
/keepalive resume           clear a sticky pause
/keepalive interval=4m      probe cadence (≥ 30s)
/keepalive maxidle=30m      idle cutoff (0 = disabled)
/keepalive miss=2           pause after N consecutive cache misses
/keepalive errors=3         pause after N consecutive probe failures
/keepalive cap=1.0          session probe-spend ceiling in USD (0 = none)
/keepalive token=512        minimum prompt size for miss classification
/keepalive maxoutput=16     probe max_tokens clamp
/keepalive reset            zero the session stats
```

All settings persist to `~/.pi/cache-keepalive/state.json`. Statistics are per-session.

## How it works

1. **Capture.** The `before_provider_headers` and `before_provider_request` hooks snapshot the headers and a `structuredClone` of the payload of each real `kimi-coding` request. In-memory only; nothing is written to disk.
2. **Replay.** While the agent is idle and enabled, the captured request is POSTed to `{baseUrl}/v1/messages` with only terminal parameters changed:

   | Change | Reason |
   | --- | --- |
   | remove `stream` | returns usage as a single JSON body |
   | remove `thinking` | API requires `max_tokens > thinking.budget_tokens`, incompatible with the clamp below |
   | `max_tokens: 16` | bounds the probe's output cost |
   | `tool_choice: {type: "none"}` | prevents a tool-call round; dropped with a retry on HTTP 400 |

   `system`, `messages`, and `tools` are kept byte-identical. These are the only inputs to the provider's prefix-cache key, so the replay matches the existing cache entry and restarts its TTL at cache-read pricing.
3. **Classification.** Response usage (`cache_read_input_tokens`, falling back to `cached_tokens`) classifies each probe as a hit or a miss. The response is otherwise discarded.

Headers are forwarded verbatim except hop-by-hop and length headers, which `fetch` manages.

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

- The ~5 minute TTL and the pricing above are observed behavior, not an API contract. The `saved` estimate is informational, not a guaranteed saving.
- Only the `kimi-coding` provider with `anthropic-messages` API routes is supported. Other providers have different cache-key semantics and are out of scope.
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