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

/** Package version, read from the package.json that ships this extension. */
function ownVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
/** Live OAuth state; resolved lazily so tests can redirect it via PI_AGENT_DIR. */
function authFile(): string {
  return join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
}

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
  /** "default" = fixed interval; "smart" = adaptive cadence that grows while probes keep hitting. */
  mode: "default" | "smart";
  /** True once the first-run setup wizard has completed (or been skipped). */
  initialized: boolean;
}

const DEFAULT_CONFIG: Readonly<PersistedConfig> = Object.freeze({
  enabled: false,
  // 8 min: real-world testing shows probes at this cadence still hit the
  // prefix cache reliably (the effective TTL runs longer than the ~5 min
  // nominal TTL), so the default cadence IS the hit-mode heartbeat — every
  // probe is billed at cache-read rates (~10x cheaper than a cold read).
  // If the cache does expire (e.g. server-side eviction), the probe misses
  // once at full price and the default miss=1 stops probing immediately.
  intervalMs: 8 * 60_000,
  maxIdleMs: 30 * 60_000,
  minPromptTokens: 512,
  maxOutputTokens: 16,
  spendCapUsd: 1.0,
  maxMissStreak: 1,
  maxErrorStreak: 3,
  mode: "default",
  initialized: false,
});

// smart-mode constants
const SMART_BASE_MS = 8 * 60_000; // smart starting/floor cadence (matches the default interval)
const SMART_STEP_MS = 30_000; // +30s per 3-hit confirmation
const SMART_CONFIRM_HITS = 3;
const SMART_MAX_CONTEXT_TOKENS = 200_000; // context cap: grow only below this
/**
 * default-mode safe floor: the nominal cache TTL. A miss while probing above
 * this cadence drops the cadence here and keeps probing (the miss probe
 * itself rebuilds the cache entry, so the next ≤5m probe renews it); only a
 * miss AT this floor counts toward the miss-pause threshold.
 */
const DEFAULT_FALLBACK_MS = 5 * 60_000;

const MIN_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;

const HELP_TEXT = [
  "pi-kimi-keepalive",
  "  /keepalive                show status",
  "  /keepalive setup          interactive first-run wizard (maxidle, miss pause, error breaker, spend cap)",
  "  /keepalive on|off         enable / disable (persisted)",
  "  /keepalive now            one manual probe (bypasses pauses)",
  "  /keepalive resume         clear a sticky pause",
  "  /keepalive mode=smart     adaptive cadence (8m floor; +30s per 3-hit confirmation; a miss parks probing, mode=smart resumes)",
  "  /keepalive mode=default   fixed cadence (the interval= value)",
  "  /keepalive interval=4m45s probe cadence (default mode; >= 30s; default 8m reliably hits the cache in practice)",
  "  /keepalive maxidle=30m    stop probing after this idle time (0 = never stop)",
  "  /keepalive miss=1         pause after N consecutive cache misses",
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
  api: string | undefined;
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
  // smart-mode runtime state (cadence itself lives in config.intervalMs, persisted)
  let smartHitStreak = 0;
  // Set when a smart-mode miss pauses probing; only re-selecting smart mode
  // clears it (a fresh real turn does NOT resume probing in this case).
  let smartPaused = false;
  let lastProbeInputTokens = 0;
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
        mode: raw.mode === "smart" ? "smart" : "default",
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
          "configure later via /keepalive maxidle=30m miss=1 errors=3 cap=1.0.",
        "info",
      );
      return;
    }

    const confirmNext = await wizardCtx.ui.confirm(
      opts.firstRun
        ? "pi-kimi-keepalive — first-time setup"
        : "pi-kimi-keepalive — reconfigure",
      "Set the keepalive guardrails. Press Esc at any prompt to keep the current value. " +
        "All values are saved to ~/.pi/cache-keepalive/state.json and can be changed later " +
        "via /keepalive <setting>.",
    );
    if (confirmNext !== true) {
      config.initialized = true;
      persistConfig();
      notify(
        "Setup skipped — defaults kept (mode default/8m, maxidle 30m, miss 1, errors 3, cap $1.00). " +
          "Run /keepalive setup to configure later, /keepalive on to enable.",
        "info",
      );
      updateUi();
      return;
    }

    // 1/5 — max idle cutoff
    const maxIdleRaw = await wizardCtx.ui.input(
      "Step 1/5 — Max idle cutoff (now " + formatDuration(config.maxIdleMs) + ")\n" +
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

    // 2/5 — miss pause threshold
    const missRaw = await wizardCtx.ui.input(
      "Step 2/5 — Miss pause threshold (now " + config.maxMissStreak + ")\n" +
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

    // 3/5 — error circuit breaker
    const errorRaw = await wizardCtx.ui.input(
      "Step 3/5 — Error circuit breaker (default " + config.maxErrorStreak + ")\n" +
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

    // 4/5 — spend cap
    const spendRaw = await wizardCtx.ui.input(
      "Step 4/5 — Session spend cap in USD (default " +
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

    // 5/5 — probing mode
    const modeRaw = await wizardCtx.ui.input(
      "Step 5/5 — Probing mode (now " + config.mode + ")\n" +
        "default: probes run at the fixed interval above.\n" +
        "smart: starts at 8m; after 3 consecutive hits (context ≤ 200k) the cadence grows by 30s; " +
        "one miss steps back to the last confirmed value and parks probing until you re-select smart mode — " +
        "it self-tunes toward the real cache TTL to minimize probe spend.\n" +
        "Type smart to enable; leave empty / press Esc for default.",
      "",
    );
    if (modeRaw !== undefined) {
      const v = modeRaw.trim().toLowerCase();
      if (v === "smart" || v === "default") {
        config.mode = v;
        smartPaused = false;
        if (v === "smart" && config.intervalMs < SMART_BASE_MS) config.intervalMs = SMART_BASE_MS;
      } else if (v !== "") {
        notify(`Unknown mode "${modeRaw}" — keeping ${config.mode}`, "error");
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
        `  mode:         ${config.mode}${config.mode === "smart" ? ` (starting at ${formatDuration(config.intervalMs)})` : ` (fixed ${formatDuration(config.intervalMs)})`}\n` +
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
    if (!model || model.provider !== "kimi-coding") return false;
    if (
      typeof model.baseUrl !== "string" ||
      model.baseUrl.length === 0
    ) {
      return false;
    }
    // kimi-coding currently routes through an OpenAI-completions-compatible
    // API ("kimi-openai-completions"); accept the anthropic-messages dialect
    // too in case the provider config changes.
    const api = (model as { api?: unknown }).api;
    return (
      api === "kimi-openai-completions" ||
      api === "anthropic-messages" ||
      (typeof api === "string" && api.endsWith("openai-completions"))
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
    return capture.api === "anthropic-messages"
      ? `${base}/v1/messages`
      : `${base}/chat/completions`;
  }

  /**
   * Resolve the probe's Authorization header. pi injects OAuth credentials
   * (kimi-coding `Authorization: Bearer <access>`) after the
   * before_provider_headers hook fires, so captured headers usually lack
   * auth; read the current token from pi's auth store instead. Falls back
   * to the forwarded captured headers if the token file is unavailable.
   */
  function probeHeaders(): Record<string, string> | null {
    if (!capture) return null;
    // Prefer the live token from auth.json: pi refreshes it there on real
    // requests, while captured request headers freeze the token from capture
    // time — hours later that Bearer can already be expired (HTTP 401).
    // Fall back to the captured headers when auth.json is unavailable.
    try {
      const raw = JSON.parse(readFileSync(authFile(), "utf8")) as Record<string, unknown>;
      const entry = (raw["kimi-coding"] ?? null) as { access?: unknown } | null;
      if (entry && typeof entry.access === "string" && entry.access.length > 0) {
        const headers = buildProbeHeaders(capture.headers);
        headers.authorization = `Bearer ${entry.access}`;
        return headers;
      }
      debug(`no kimi-coding access token in ${authFile()}`);
    } catch (error) {
      debug(
        `auth.json unavailable (${error instanceof Error ? error.message : String(error)}) — falling back to captured headers`,
      );
    }
    const headers = buildProbeHeaders(capture.headers);
    return headers.authorization ? headers : null;
  }

  async function runProbe(): Promise<boolean> {
    if (inflight || !capture) return false;
    inflight = true;
    try {
      const endpoint = probeEndpoint();
      if (!endpoint) return false;
      for (let attempt = 1 as 1 | 2; attempt <= 2; attempt++) {
        const built = buildProbeBody(capture.payload, config.maxOutputTokens, capture.api, attempt);
        if (!built.ok) {
          recordFailure(`captured payload not replayable: ${built.reason}`);
          return false;
        }
        let response: Response;
        const probeRequestHeaders = probeHeaders();
        if (!probeRequestHeaders) {
          recordFailure("no Kimi credentials available for the probe");
          return false;
        }
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: probeRequestHeaders,
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
        // One retry with a further-reduced terminal-parameter set when the
        // endpoint rejects the probe's extras; the conversation prefix is
        // never modified.
        const retryable = response.status === 400 && attempt === 1;
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
    lastProbeInputTokens = usage.inputTokens;

    if (!isCacheMiss(usage.inputTokens, usage.cacheReadTokens, config.minPromptTokens)) {
      stats.hits += 1;
      stats.savedUsd += estimateSavedUsd(usage.cacheReadTokens, capture.cost);
      missStreak = 0;
      errorStreak = 0;
      debug(
        `probe hit: cache_read=${usage.cacheReadTokens} input=${usage.inputTokens} saved=${stats.savedUsd.toFixed(4)}`,
      );
      if (config.mode === "smart") {
        smartAdaptAfterHit(usage.inputTokens);
      }
    } else {
      stats.misses += 1;
      debug(`probe miss: cache_read=0 input=${usage.inputTokens}`);
      if (config.mode === "smart") {
        smartAdaptAfterMiss();
      } else if (config.intervalMs > DEFAULT_FALLBACK_MS) {
        // Miss while probing above the safe floor: the miss probe itself
        // rebuilds the cache entry with the same prefix, so drop to the 5m
        // safe cadence (inside the nominal TTL) and keep probing — the next
        // probe renews it. Reset the streak so the new cadence gets a fresh
        // chance before a pause is considered.
        config.intervalMs = DEFAULT_FALLBACK_MS;
        missStreak = 0;
        persistConfig();
        notify(
          `cache miss — cadence backed off to ${formatDuration(config.intervalMs)} (safe TTL window); probing continues`,
          "info",
        );
        updateUi();
      } else {
        missStreak += 1;
        debug(`probe miss #${missStreak}: cache_read=0 input=${usage.inputTokens}`);
        if (missStreak >= config.maxMissStreak) {
          pause("probes stopped hitting the prefix cache; waiting for your next real turn");
        }
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

  /**
   * smart-mode cadence adaptation.
   *
   * config.intervalMs doubles as the persisted "last confirmed cadence":
   * promotion only ever happens after SMART_CONFIRM_HITS consecutive hits, so
   * the value on disk is always one the cache has actually held for. A miss
   * steps back 30s to that last confirmed value (never below the 8m floor),
   * persists it, and pauses probing — a fresh real turn does NOT resume;
   * only re-selecting smart mode (`/keepalive mode=smart`) continues.
   * Contexts above 200k tokens are never pushed upward and immediately revert
   * to the floor cadence, because a miss there costs too much full-price
   * input to risk.
   */
  function smartAdaptAfterHit(inputTokens: number): void {
    if (inputTokens > SMART_MAX_CONTEXT_TOKENS) {
      // Too expensive to experiment; drop to floor and stop growing.
      if (config.intervalMs > SMART_BASE_MS) {
        config.intervalMs = SMART_BASE_MS;
        persistConfig();
        notify(
          `smart: context ${inputTokens} tokens exceeds ${SMART_MAX_CONTEXT_TOKENS / 1000}k — cadence back to the 8m floor`,
          "info",
        );
      }
      smartHitStreak = 0;
      updateUi();
      return;
    }
    smartHitStreak += 1;
    if (smartHitStreak < SMART_CONFIRM_HITS) return;
    const roomUnderMaxIdle =
      config.maxIdleMs === 0 || config.intervalMs + SMART_STEP_MS < config.maxIdleMs;
    if (roomUnderMaxIdle) {
      config.intervalMs += SMART_STEP_MS; // 3-hit-confirmed value stays on disk
      persistConfig();
      debug(
        `smart: ${smartHitStreak} consecutive hits — cadence grows to ${formatDuration(config.intervalMs)}`,
      );
    }
    smartHitStreak = 0;
    updateUi();
  }

  function smartAdaptAfterMiss(): void {
    smartHitStreak = 0;
    const fellBack = config.intervalMs > SMART_BASE_MS;
    if (fellBack) {
      // Step back to the last confirmed cadence before pausing.
      config.intervalMs = Math.max(SMART_BASE_MS, config.intervalMs - SMART_STEP_MS);
      persistConfig();
    }
    smartPaused = true;
    pause(
      `cache miss in smart mode — cadence ${fellBack ? `back to ${formatDuration(config.intervalMs)}` : "already at the floor"}; ` +
        `probing stopped, run /keepalive mode=smart to resume`,
    );
    updateUi();
  }

  function recordFailure(message: string): void {
    stats.errors += 1;
    errorStreak += 1;
    debug("probe failed:", message);
    if (/^HTTP 40[13]\b/.test(message)) {
      // Credentials are dead regardless of history; clear the streaks so the
      // automatic recovery after the next real turn starts from a clean slate.
      missStreak = 0;
      errorStreak = 0;
      smartHitStreak = 0;
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
        `pi-kimi-keepalive v${ownVersion()}`,
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
      ? `${capture.provider} (${capture.api ?? "unknown api"}) @ ${capture.baseUrl}`
      : "none yet — probes start after your first real turn";
    return [
      `pi-kimi-keepalive v${ownVersion()}`,
      `  state:     ${config.enabled ? "on" : "off"}${pausedReason ? ` (paused: ${pausedReason})` : ""}`,
      `  capture:   ${route}`,
      `  mode: ${config.mode}${config.mode === "smart" ? ` · cadence ${formatDuration(config.intervalMs)}${lastProbeInputTokens > SMART_MAX_CONTEXT_TOKENS ? ` · context ${lastProbeInputTokens.toLocaleString()} > cap, frozen at floor` : ""}` : " (fixed via interval=)"}`,
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
            if (smartPaused) {
              notify("smart-mode pause is intentional — run /keepalive mode=smart to resume probing", "warning");
              break;
            }
            pausedReason = null;
            missStreak = 0;
            errorStreak = 0;
            smartHitStreak = 0;
            notify("keepalive resumed", "info");
            break;
          case "mode": {
            const next = value === "smart" || value === "default" ? value : null;
            if (next === null) {
              notify("usage: /keepalive mode=smart (adaptive) or mode=default (fixed)", "error");
              break;
            }
            config.mode = next;
            smartHitStreak = 0;
            smartPaused = false; // re-selecting the mode is the documented way out of a smart miss-pause
            if (next === "smart") {
              // smart manages the cadence itself; snap back to its floor.
              if (config.intervalMs < SMART_BASE_MS) config.intervalMs = SMART_BASE_MS;
              notify(
                `mode=smart — probing resumes at ${formatDuration(config.intervalMs)}; +30s per ${SMART_CONFIRM_HITS} hits (context ≤ ${SMART_MAX_CONTEXT_TOKENS / 1000}k), one miss parks probing`,
                "info",
              );
            } else {
              notify("mode=default — fixed cadence via /keepalive interval=<duration>", "info");
            }
            persistConfig();
            updateUi();
            break;
          }
          case "interval": {
            if (config.mode === "smart") {
              notify("smart mode manages the cadence itself — use /keepalive mode=default to set it manually", "warning");
              break;
            }
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
            config.maxIdleMs = ms;
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
    let clonedPayload: Record<string, unknown>;
    try {
      clonedPayload = structuredClone(raw);
    } catch {
      // DataCloneError: the payload carries non-cloneable values (BigInt,
      // symbols, functions). Fall back to a JSON round-trip; probing never
      // mutates the captured payload, so a by-reference capture is the last
      // resort rather than failing the real request.
      try {
        clonedPayload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
      } catch {
        debug("payload not cloneable — capturing by reference");
        clonedPayload = raw;
      }
    }
    capture = {
      payload: clonedPayload,
      headers: capturedHeaders,
      provider: model.provider,
      api: (model as { api?: string }).api,
      baseUrl: model.baseUrl ?? "",
      cost: (model.cost ?? undefined) as Partial<CostPerM> | undefined,
    };
    // A fresh real request means fresh credentials and a warm prefix cache;
    // automatically recover from any sticky pause. Exception: a smart-mode
    // miss intentionally parks probing until the user re-selects smart mode.
    if (pausedReason !== null || missStreak > 0 || errorStreak > 0) {
      if (smartPaused) {
        if (pausedReason !== null) {
          debug("fresh real request observed — smart-mode miss pause kept; /keepalive mode=smart to resume");
          missStreak = 0;
          errorStreak = 0;
          updateUi();
          return;
        }
      } else {
        pausedReason = null;
        debug("fresh real request observed — keepalive unpaused");
      }
      missStreak = 0;
      errorStreak = 0;
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