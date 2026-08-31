/**
 * pi-kimi-keepalive — keeps the Kimi (provider "kimi-coding") automatic
 * prompt cache warm during long idle gaps in Pi sessions.
 *
 * Mechanism:
 *   1. Every real provider request is observed read-only via the
 *      `before_provider_headers` / `before_provider_request` hooks. The full
 *      payload (system/messages/tools, including any cache_control markers)
 *      and its auth headers are captured.
 *   2. While the session sits idle, the captured request is replayed as a
 *      small non-streaming call: `max_tokens` clamped, `thinking` removed,
 *      `stream` removed, `tool_choice: none` added (with a one-shot fallback
 *      if the endpoint rejects it). The conversation prefix is untouched, so
 *      the provider's automatic prefix cache sees it as a continuation and
 *      restarts the cache TTL at cache-read prices.
 *   3. Probes never enter the Pi session: no synthetic user messages, no
 *      synthetic tool runs, no model output kept anywhere. Only aggregate
 *      probe statistics (hits / misses / estimated savings) are surfaced.
 *
 * Guardrails: probes are skipped while the agent is busy, stop after
 * `maxidle`, after repeated cache misses, on auth failures, or when the
 * session spend cap is reached. A fresh real request always re-arms and
 * clears sticky pauses.
 *
 * This depends on Kimi's automatic context caching. The cache TTL is not a
 * contractual guarantee of the provider; treat this extension as an
 * experiment with guardrails, not a savings promise.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildProbeBody,
  buildProbeHeaders,
  estimateSavedUsd,
  estimateProbeSpendUsd,
  formatClock,
  formatDuration,
  formatUsd,
  hasPricing,
  isCacheMiss,
  parseDurationMs,
  parseUsage,
  parseUsageFromSse,
  parseUsd,
  type CostPerM,
  type ParsedUsage,
} from "./lib.ts";

const STATE_DIR = join(homedir(), ".pi", "cache-keepalive");
const STATE_FILE = join(STATE_DIR, "state.json");

interface PersistedConfig {
  enabled: boolean;
  intervalMs: number;
  /** Stop automatic probing after this much idle time; 0 disables. */
  maxIdleMs: number;
  /** Minimum full-price prompt size (tokens) before a probe counts as a miss. */
  minPromptTokens: number;
  /** max_tokens clamp for probe requests. */
  maxOutputTokens: number;
  /** Session probe-spend ceiling in USD; null disables the cap. */
  spendCapUsd: number | null;
  /** Consecutive cache misses before probing pauses. */
  maxMissStreak: number;
  /** Consecutive failed probes (network/server errors) before probing pauses. */
  maxErrorStreak: number;
  /** True once the first-run setup wizard has completed (or been skipped). */
  initialized: boolean;
}

const DEFAULT_CONFIG: Readonly<PersistedConfig> = Object.freeze({
  enabled: false,
  intervalMs: 4 * 60_000,
  maxIdleMs: 30 * 60_000,
  minPromptTokens: 512,
  maxOutputTokens: 16,
  spendCapUsd: 1.0,
  maxMissStreak: 2,
  maxErrorStreak: 3,
  initialized: false,
});

const MIN_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;

const HELP_TEXT = [
  "pi-kimi-keepalive",
  "  /keepalive                show status",
  "  /keepalive setup          interactive first-run wizard (maxidle, miss pause, error breaker, spend cap)",
  "  /keepalive on|off         enable / disable (persisted)",
  "  /keepalive now            one manual probe (bypasses pauses)",
  "  /keepalive resume         clear a sticky pause",
  "  /keepalive interval=4m    probe cadence (>= 30s)",
  "  /keepalive maxidle=30m    stop probing after this idle time (0 = never stop)",
  "  /keepalive miss=2         pause after N consecutive cache misses",
  "  /keepalive errors=3       pause after N consecutive probe failures",
  "  /keepalive cap=1.0        session probe-spend ceiling in USD (0 = none)",
  "  /keepalive token=512      minimum cached prompt size for miss detection",
  "  /keepalive maxoutput=16   probe max_tokens clamp",
  "  /keepalive reset          zero the session stats",
].join("\n");

interface Capture {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  provider: string;
  baseUrl: string;
  cost: Partial<CostPerM> | undefined;
}

interface Stats {
  probes: number;
  hits: number;
  misses: number;
  errors: number;
  savedUsd: number;
  spendUsd: number;
}

export default function (pi: ExtensionAPI) {
  // ---------- mutable state ----------

  let config: PersistedConfig = { ...DEFAULT_CONFIG };

  let ctx: ExtensionContext | null = null;
  let capture: Capture | null = null;
  let capturedHeaders: Record<string, string> = {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextProbeAt: number | null = null;
  let lastSettledAt = Date.now();
  let inflight = false;

  let pausedReason: string | null = null;
  let missStreak = 0;
  let errorStreak = 0;

  const stats: Stats = { probes: 0, hits: 0, misses: 0, errors: 0, savedUsd: 0, spendUsd: 0 };

  // ---------- persistence ----------

  function readConfigFromDisk(): boolean {
    // Returns whether a config file already existed on disk.
    const existed = existsSync(STATE_FILE);
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<PersistedConfig>;
      const int = (value: unknown, fallback: number, min = 1, cap = Number.MAX_SAFE_INTEGER): number =>
        typeof value === "number" && Number.isFinite(value) && value >= min
          ? Math.min(Math.floor(value), cap)
          : fallback;
      config = {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
        intervalMs: int(raw.intervalMs, DEFAULT_CONFIG.intervalMs, 1_000),
        maxIdleMs:
          raw.maxIdleMs === 0
            ? 0
            : int(raw.maxIdleMs, DEFAULT_CONFIG.maxIdleMs),
        minPromptTokens: int(raw.minPromptTokens, DEFAULT_CONFIG.minPromptTokens, 0),
        maxOutputTokens: int(raw.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 1, 4096),
        spendCapUsd:
          raw.spendCapUsd === 0 || raw.spendCapUsd === null
            ? null // 0/null both mean "no cap"
            : typeof raw.spendCapUsd === "number" &&
                Number.isFinite(raw.spendCapUsd) &&
                raw.spendCapUsd > 0
              ? raw.spendCapUsd
              : DEFAULT_CONFIG.spendCapUsd,
        maxMissStreak: int(raw.maxMissStreak, DEFAULT_CONFIG.maxMissStreak, 1),
        maxErrorStreak: int(raw.maxErrorStreak, DEFAULT_CONFIG.maxErrorStreak, 1),
          initialized: raw.initialized === true,
      };
    } catch {
      config = { ...DEFAULT_CONFIG };
    }
    return existed;
  }

  function persistConfig(): void {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(config, null, 2) + "\n");
    } catch (error) {
      debug("failed to persist config:", error);
    }
  }

  // ---------- setup wizard ----------

  async function runSetupWizard(wizardCtx: ExtensionContext, opts: { firstRun: boolean }): Promise<void> {
    if (wizardCtx.hasUI !== true || typeof wizardCtx.ui?.input !== "function") {
      // Headless / remote session: nothing to interact with, keep defaults.
      notify(
        "pi-kimi-keepalive setup needs an interactive UI. Defaults are in effect; " +
          "configure later via /keepalive maxidle=30m miss=2 errors=3 cap=1.0.",
        "info",
      );
      return;
    }

    const confirmNext = await wizardCtx.ui.confirm(
      "pi-kimi-keepalive — first-time setup",
      "Set the keepalive guardrails. Press Esc at any prompt to keep the default. " +
        "All values are saved to ~/.pi/cache-keepalive/state.json and can be changed later " +
        "via /keepalive <setting>.",
    );
    if (confirmNext !== true) {
      config.initialized = true;
      persistConfig();
      notify(
        "Setup skipped — defaults kept (interval 4m, maxidle 30m, miss 2, errors 3, cap $1.00). " +
          "Run /keepalive setup to configure later, /keepalive on to enable.",
        "info",
      );
      updateUi();
      return;
    }

    // 1/4 — max idle cutoff
    const maxIdleRaw = await wizardCtx.ui.input(
      "Step 1/4 — Max idle cutoff (now " + formatDuration(config.maxIdleMs) + ")\n" +
        "Stop probing once you have been idle longer than this, so a session left overnight " +
        "does not keep spending quota. Examples: 30m, 1h, 2h — or 0 to never stop.\n" +
        "Leave empty / press Esc to keep the default (30m).",
      "30m",
    );
    if (maxIdleRaw !== undefined && maxIdleRaw.trim() !== "") {
      const ms = parseDurationMs(maxIdleRaw);
      if (ms === null) {
        if (maxIdleRaw.trim() === "0") {
          config.maxIdleMs = 0;
        } else {
          notify(`Invalid duration "${maxIdleRaw}" — keeping ${config.maxIdleMs === 0 ? "disabled" : formatDuration(config.maxIdleMs)}`, "error");
        }
      } else {
        config.maxIdleMs = ms;
      }
    }

    // 2/4 — miss pause threshold
    const missRaw = await wizardCtx.ui.input(
      "Step 2/4 — Miss pause threshold (now " + config.maxMissStreak + ")\n" +
        "Pause probing after this many consecutive probes that did NOT hit the prompt cache " +
        "(a cache hit resets the count). A high cache-read price with no hits means the " +
        "provider's caching behaviour changed; pausing keeps you from burning quota blindly.",
      String(config.maxMissStreak),
    );
    if (missRaw !== undefined && missRaw.trim() !== "") {
      const n = Number(missRaw);
      if (!Number.isInteger(n) || n < 1) {
        notify(`Invalid miss threshold "${missRaw}" — keeping ${config.maxMissStreak}`, "error");
      } else {
        config.maxMissStreak = n;
      }
    }

    // 3/4 — error circuit breaker
    const errorRaw = await wizardCtx.ui.input(
      "Step 3/4 — Error circuit breaker (default " + config.maxErrorStreak + ")\n" +
        "Pause probing after this many consecutive failed probes (network errors, HTTP 5xx). " +
        "Auth failures (HTTP 401/403) always pause immediately regardless of this value.",
      String(config.maxErrorStreak),
    );
    if (errorRaw !== undefined && errorRaw.trim() !== "") {
      const n = Number(errorRaw);
      if (!Number.isInteger(n) || n < 1) {
        notify(`Invalid error threshold — keeping ${config.maxErrorStreak}`, "error");
      } else {
        config.maxErrorStreak = n;
      }
    }

    // 4/4 — spend cap
    const spendRaw = await wizardCtx.ui.input(
      "Step 4/4 — Session spend cap in USD (default " +
        formatUsd(DEFAULT_CONFIG.spendCapUsd ?? 1.0) +
        ")\n" +
        "Ceiling on the estimated USD cost of probes in this session. A probe costs roughly " +
        "the cache-read price of your whole context (about $0.03 per probe at 100k tokens). " +
        "If you're on a Kimi subscription this is still a useful rough gauge. 0 disables the cap.",
      "1.0",
    );
    if (spendRaw !== undefined && spendRaw.trim() !== "") {
      const usd = parseUsd(spendRaw);
      if (usd === null) {
        notify("Invalid USD value — keeping the default cap", "error");
      } else {
        config.spendCapUsd = usd === 0 ? null : usd;
      }
    }

    config.initialized = true;
    persistConfig();

    const enable = await wizardCtx.ui.confirm(
      "Enable keepalive now?",
      "Probing starts after your next real turn (it needs one captured request first). " +
        "You can toggle anytime with /keepalive on / off.",
    );
    if (enable === true) {
      config.enabled = true;
      pausedReason = null;
    }
    persistConfig();
    persistConfig();
    notify(
      "pi-kimi-keepalive configured:\n" +
        `  maxidle:      ${config.maxIdleMs === 0 ? "never stop" : formatDuration(config.maxIdleMs)}\n` +
        `  miss pause:   after ${config.maxMissStreak} consecutive cache misses\n` +
        `  error breaker: ${config.maxErrorStreak} consecutive failures\n` +
        `  spend cap:    ${config.spendCapUsd === null ? "none" : formatUsd(config.spendCapUsd)}\n` +
        "  /keepalive status anytime — /keepalive on|off to toggle.",
      "info",
    );
    updateUi();
  }


  function isTargetModel(context: ExtensionContext | null): boolean {
    const model = context?.model;
    return Boolean(
      model &&
        model.provider === "kimi-coding" &&
        model.api === "anthropic-messages" &&
        typeof model.baseUrl === "string" &&
        model.baseUrl.length > 0,
    );
  }

  function splitSetting(token: string): [string, string | undefined] {
    const eq = token.indexOf("=");
    if (eq === -1) return [token, undefined];
    return [token.slice(0, eq), token.slice(eq + 1)];
  }

  // ---------- scheduling ----------

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    nextProbeAt = null;
  }

  function armed(): boolean {
    return Boolean(config.enabled && capture && !pausedReason && !inflight);
  }

  function schedule(delayMs?: number): void {
    clearTimer();
    if (!armed()) return;
    const delay = Math.max(1_000, delayMs ?? config.intervalMs);
    nextProbeAt = Date.now() + delay;
    timer = setTimeout(() => {
      timer = null;
      void onTick();
    }, delay);
    // A pending keepalive timer must never keep the process alive.
    if (timer && typeof (timer as { unref?: unknown }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    updateUi();
  }

  async function onTick(): Promise<void> {
    if (!ctx || !capture) return;
    if (!ctx.isIdle()) {
      debug("tick skipped: agent busy; agent_settled will re-arm");
      return;
    }
    const idleFor = Date.now() - lastSettledAt;
    if (config.maxIdleMs > 0 && idleFor >= config.maxIdleMs) {
      pause(`idle for more than maxidle (${formatDuration(idleFor)})`);
      return;
    }
    await runProbe();
    if (pausedReason) updateUi();
    else schedule();
  }

  function pause(reason: string): void {
    pausedReason = reason;
    clearTimer();
    notify(`pi-kimi-keepalive paused — ${reason} (/keepalive resume to retry)`, "warning");
    updateUi();
  }

  // ---------- probing ----------

  function probeEndpoint(): string | null {
    if (!capture) return null;
    const base = capture.baseUrl.replace(/\/+$/, "");
    if (!/^https:\/\//.test(base)) return null;
    return `${base}/v1/messages`;
  }

  async function runProbe(): Promise<boolean> {
    if (inflight || !capture) return false;
    inflight = true;
    try {
      const endpoint = probeEndpoint();
      if (!endpoint) return false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const built = buildProbeBody(capture.payload, config.maxOutputTokens, attempt === 1);
        if (!built.ok) {
          recordFailure(`captured payload not replayable: ${built.reason}`);
          return false;
        }
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: buildProbeHeaders(capture.headers),
            body: JSON.stringify(built.body),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
        } catch (error) {
          recordFailure(`network error: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
        const text = await response.text();
        if (response.ok) {
          recordProbeResult(text);
          return true;
        }
        debug(`probe attempt ${attempt} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
        // One retry without tool_choice if the endpoint rejects the probe's
        // extra parameters; the conversation prefix is never modified.
        const retryable =
          response.status === 400 && attempt === 1 && /tool_choice|thinking|stream/i.test(text);
        if (!retryable) {
          recordFailure(`HTTP ${response.status}`);
          return false;
        }
      }
      return false;
    } finally {
      inflight = false;
      updateUi();
    }
  }

  function recordProbeResult(text: string): void {
    let usage: ParsedUsage;
    try {
      usage = parseUsage(JSON.parse(text) as unknown);
    } catch {
      usage = parseUsageFromSse(text);
    }
    applyProbeUsage(usage);
  }

  function applyProbeUsage(usage: ParsedUsage): void {
    if (!capture) return;
    stats.probes += 1;
    stats.spendUsd += estimateProbeSpendUsd(usage, capture.cost);

    if (!isCacheMiss(usage.inputTokens, usage.cacheReadTokens, config.minPromptTokens)) {
      stats.hits += 1;
      stats.savedUsd += estimateSavedUsd(usage.cacheReadTokens, capture.cost);
      missStreak = 0;
      errorStreak = 0;
      debug(
        `probe hit: cache_read=${usage.cacheReadTokens} input=${usage.inputTokens} saved=${stats.savedUsd.toFixed(4)}`,
      );
    } else {
      stats.misses += 1;
      missStreak += 1;
      debug(`probe miss #${missStreak}: cache_read=0 input=${usage.inputTokens}`);
      if (missStreak >= config.maxMissStreak) {
        pause("probes stopped hitting the prefix cache; waiting for your next real turn");
      }
    }

    if (
      !pausedReason &&
      config.spendCapUsd !== null &&
      stats.spendUsd >= config.spendCapUsd
    ) {
      pause(
        `probe spend ${formatUsd(stats.spendUsd)} reached the cap ${formatUsd(config.spendCapUsd)}`,
      );
    }
  }

  function recordFailure(message: string): void {
    stats.errors += 1;
    errorStreak += 1;
    debug("probe failed:", message);
    if (/^HTTP 40[13]\b/.test(message)) {
      pause("captured credentials rejected; will recapture after your next real turn");
      return;
    }
    if (errorStreak >= config.maxErrorStreak) {
      pause(`${errorStreak} consecutive probe failures (last: ${message})`);
    }
  }

  // ---------- UI ----------

  function notify(text: string, level?: "info" | "warning" | "error"): void {
    debug(text);
    if (ctx?.hasUI !== true) return;
    try {
      ctx.ui.notify(text, level ?? "info");
    } catch {
      // UI unavailable; ignore.
    }
  }

  function updateUi(): void {
    if (ctx?.hasUI !== true) return;
    try {
      const state = pausedReason
        ? `paused — ${pausedReason}`
        : !config.enabled
          ? "off (/keepalive on)"
          : capture
            ? `armed · every ${formatDuration(config.intervalMs)} · next ${formatClock(nextProbeAt)}`
            : "on · waiting for the first real turn";
      const savings = hasPricing(capture?.cost) ? formatUsd(stats.savedUsd) : "n/a (no price data)";
      ctx.ui.setStatus("cache-keepalive", `♥ ${state}`);
      ctx.ui.setWidget("cache-keepalive", [
        "pi-kimi-keepalive",
        `  state:   ${state}`,
        `  probes:  ${stats.probes} sent · ${stats.hits} hits · ${stats.misses} misses · ${stats.errors} errors`,
        `  est.:    saved ${savings} · probe spend ${formatUsd(stats.spendUsd)} · cap ${config.spendCapUsd === null ? "none" : formatUsd(config.spendCapUsd)}`,
      ]);
    } catch {
      // UI unavailable; ignore.
    }
  }

  function debug(...parts: unknown[]): void {
    if (process.env.PI_KEEPALIVE_DEBUG) {
      process.stderr.write(`[pi-kimi-keepalive] ${parts.map(String).join(" ")}\n`);
    }
  }

  // ---------- command ----------

  function statusLines(): string[] {
    const route = capture
      ? `${capture.provider} @ ${capture.baseUrl}`
      : "none yet — probes start after your first real turn";
    return [
      "pi-kimi-keepalive",
      `  state:     ${config.enabled ? "on" : "off"}${pausedReason ? ` (paused: ${pausedReason})` : ""}`,
      `  capture:   ${route}`,
      `  interval:  ${formatDuration(config.intervalMs)} · maxidle ${config.maxIdleMs === 0 ? "off" : formatDuration(config.maxIdleMs)} · minPromptTokens ${config.minPromptTokens} · maxOutput ${config.maxOutputTokens}`,
      `  spend cap: ${config.spendCapUsd === null ? "none" : formatUsd(config.spendCapUsd)} · est. probe spend ${formatUsd(stats.spendUsd)}`,
      `  probes:    ${stats.probes} (hits ${stats.hits}, misses ${stats.misses}, errors ${stats.errors})`,
      `  saved:     ${hasPricing(capture?.cost) ? formatUsd(stats.savedUsd) : "n/a (no price data)"} · next probe ${formatClock(nextProbeAt)}`,
    ];
  }

  pi.registerCommand("keepalive", {
    description:
      "Kimi prompt-cache keepalive: setup|on|off|now|resume|status|reset|interval=4m|maxidle=30m|miss=2|errors=3|cap=1|token=512|maxoutput=16",
    handler: async (args, commandCtx) => {
      ctx = commandCtx;
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0 || tokens[0] === "status") {
        notify(statusLines().join("\n"), "info");
        return;
      }
      for (const token of tokens) {
        const [key, value] = splitSetting(token);
        switch (key) {
          case "setup":
            await runSetupWizard(commandCtx, { firstRun: false });
            break;
          case "on":
            config.enabled = true;
            pausedReason = null;
            persistConfig();
            notify(
              capture
                ? `keepalive on — probing every ${formatDuration(config.intervalMs)}`
                : "keepalive on — probing starts after your next real turn",
              "info",
            );
            break;
          case "off":
            config.enabled = false;
            persistConfig();
            clearTimer();
            notify("keepalive off", "info");
            break;
          case "now":
            if (!capture) {
              notify("nothing captured yet — run one real turn first", "warning");
            } else if (commandCtx.isIdle()) {
              pausedReason = null;
              const ok = await runProbe();
              notify(ok ? statusLines().join("\n") : "probe failed — see /keepalive status", "info");
              if (ok && !pausedReason && config.enabled) schedule();
            } else {
              notify("agent is busy; probe skipped", "info");
            }
            break;
          case "resume":
            pausedReason = null;
            missStreak = 0;
            errorStreak = 0;
            notify("keepalive resumed", "info");
            break;
          case "interval": {
            const ms = value !== undefined ? parseDurationMs(value) : null;
            if (ms === null || ms < MIN_INTERVAL_MS) {
              notify(`/keepalive interval=${value ?? "?"} rejected — minimum 30s, e.g. interval=4m`, "error");
              break;
            }
            config.intervalMs = ms;
            persistConfig();
            notify(`interval set to ${formatDuration(ms)}`, "info");
            break;
          }
          case "maxidle": {
            if (value === "0") {
              config.maxIdleMs = 0;
              persistConfig();
              notify("maxidle disabled — probing continues while idle", "info");
              break;
            }
            const ms = value !== undefined ? parseDurationMs(value) : null;
            if (ms === null) {
              notify("usage: /keepalive maxidle=30m (0 disables the cutoff)", "error");
              break;
            }
            persistConfig();
            notify(ms === 0 ? "maxidle disabled — probing continues while idle" : `maxidle set to ${formatDuration(ms)}`, "info");
            break;
          }
          case "miss": {
            const n = value !== undefined ? Number(value) : NaN;
            if (!Number.isInteger(n) || n < 1) {
              notify("usage: /keepalive miss=2 (pause after N consecutive cache misses)", "error");
              break;
            }
            config.maxMissStreak = n;
            persistConfig();
            notify(`miss pause threshold set to ${n} consecutive cache misses`, "info");
            break;
          }
          case "errors": {
            const n = value !== undefined ? Number(value) : NaN;
            if (!Number.isInteger(n) || n < 1) {
              notify("usage: /keepalive errors=3 (pause after N consecutive probe failures)", "error");
              break;
            }
            config.maxErrorStreak = n;
            persistConfig();
            notify(`error circuit breaker set to ${n} consecutive failures`, "info");
            break;
          }
          case "cap": {
            const usd = value !== undefined ? parseUsd(value) : null;
            if (usd === null) {
              notify("usage: /keepalive cap=1.0 (0 removes the cap)", "error");
              break;
            }
            config.spendCapUsd = usd === 0 ? null : usd;
            persistConfig();
            notify(
              config.spendCapUsd === null
                ? "spend cap removed"
                : `spend cap set to ${formatUsd(config.spendCapUsd)}`,
              "info",
            );
            break;
          }
          case "token": {
            const n = value !== undefined ? Number(value) : NaN;
            if (!Number.isFinite(n) || n < 0) {
              notify("usage: /keepalive token=512", "error");
              break;
            }
            config.minPromptTokens = Math.floor(n);
            persistConfig();
            notify(`minPromptTokens set to ${config.minPromptTokens}`, "info");
            break;
          }
          case "maxoutput": {
            const n = value !== undefined ? Number(value) : NaN;
            if (!Number.isFinite(n) || n < 1 || n > 4096) {
              notify("usage: /keepalive maxoutput=16 (1..4096)", "error");
              break;
            }
            config.maxOutputTokens = Math.floor(n);
            persistConfig();
            notify(`maxOutputTokens set to ${config.maxOutputTokens}`, "info");
            break;
          }
          case "reset":
            stats.probes = 0;
            stats.hits = 0;
            stats.misses = 0;
            stats.errors = 0;
            stats.savedUsd = 0;
            stats.spendUsd = 0;
            notify("stats reset", "info");
            break;
          default:
            notify(HELP_TEXT, "info");
        }
      }
      updateUi();
      if (config.enabled && !pausedReason && capture && !timer && !inflight) schedule();
    },
  });

  // ---------- hooks ----------

  pi.on("before_provider_headers", (event) => {
    if (!ctx || !isTargetModel(ctx)) return;
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(event.headers ?? {})) {
      if (typeof value === "string") record[key] = value;
    }
    capturedHeaders = record;
  });

  pi.on("before_provider_request", (event) => {
    if (!ctx || !isTargetModel(ctx)) return;
    const model = ctx.model;
    const payload: unknown = event.payload;
    if (!model || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const raw = payload as Record<string, unknown>;
    if (!Array.isArray(raw.messages) || raw.messages.length === 0) return;
    if (raw.system !== undefined && !Array.isArray(raw.system) && typeof raw.system !== "string") return;
    capture = {
      payload: structuredClone(raw),
      headers: capturedHeaders,
      provider: model.provider,
      baseUrl: model.baseUrl ?? "",
      cost: (model.cost ?? undefined) as Partial<CostPerM> | undefined,
    };
    // A fresh real request means fresh credentials and a warm prefix cache;
    // automatically recover from any sticky pause.
    if (pausedReason !== null || missStreak > 0 || errorStreak > 0) {
      pausedReason = null;
      missStreak = 0;
      errorStreak = 0;
      debug("fresh real request observed — keepalive unpaused");
    }
    updateUi();
  });

  pi.on("session_start", async (event, sessionCtx) => {
    ctx = sessionCtx;
    const configExisted = readConfigFromDisk();
    // Captures are bound to the previous session's credentials; require a new capture.
    capture = null;
    capturedHeaders = {};
    lastSettledAt = Date.now();
    clearTimer();
    if (
      event.reason === "startup" &&
      !configExisted &&
      sessionCtx.hasUI === true &&
      typeof sessionCtx.ui?.input === "function"
    ) {
      // Fresh install: walk the user through the guardrails once.
      try {
        await runSetupWizard(sessionCtx, { firstRun: true });
      } catch (error) {
        debug("setup wizard failed:", error instanceof Error ? error.message : error);
      }
    }
    updateUi();
  });

  pi.on("agent_settled", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    lastSettledAt = Date.now();
    if (armed()) schedule();
    else updateUi();
  });

  pi.on("agent_start", async () => {
    // Real activity refreshes the cache by itself; do not probe meanwhile.
    clearTimer();
    updateUi();
  });

  pi.on("session_shutdown", async () => {
    clearTimer();
  });
}