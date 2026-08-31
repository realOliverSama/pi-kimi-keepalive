/**
 * Tests for pi-kimi-keepalive.
 *
 * Runs with plain Node (v22.18+/v24 native TS type-stripping, no build step):
 *   node --test test/
 *
 * HOME is redirected to a temp dir before importing src/index.ts so the
 * module-level STATE_FILE (computed via homedir()) lives in the temp tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "pi-keepalive-test-"));

const { default: factory } = await import("../src/index.ts");
import * as lib from "../src/lib.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.kimi.com/coding/v1";

const PAYLOAD = {
  model: "k3",
  messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi!" }] },
  ],
  stream: true,
  prompt_cache_key: "sess-abc123",
  prompt_cache_retention: "5m",
  stream_options: { include_usage: true },
  store: true,
  max_completion_tokens: 8192,
  temperature: 1,
  tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } }],
  thinking: { effort: "high" },
};

const HEADERS = {
  authorization: "Bearer test-token",
  "user-agent": "pi/0.84.4",
  "content-type": "application/json",
  "content-length": "12345",
  host: "api.kimi.com",
  connection: "keep-alive",
};

const K3_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };

const HIT_USAGE = { usage: { input_tokens: 52_000, output_tokens: 4, cache_read_input_tokens: 50_000 } };
const MISS_USAGE = { usage: { input_tokens: 52_000, output_tokens: 4, cache_read_input_tokens: 0 } };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATE_DIR = () => join(process.env.HOME, ".pi", "cache-keepalive");
const statePath = () => join(STATE_DIR(), "state.json");

const clearHomeState = () => {
  rmSync(statePath(), { force: true });
};

function writeState(cfg) {
  mkdirSync(STATE_DIR(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify({ ...cfg }));
}

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    async emit(name, event, ctx) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
    async command(args, ctx) {
      const def = commands.get("keepalive");
      assert.ok(def, "command keepalive not registered");
      await def.handler(args, ctx);
    },
  };
}

function makeCtx({ idle = true, model, inputs = [], confirms = [] } = {}) {
  const ctx = {
    model: model ?? {
      id: "k3",
      provider: "kimi-coding",
      api: "kimi-openai-completions",
      baseUrl: BASE_URL,
      cost: K3_COST,
    },
    hasUI: true,
    idle,
    isIdle: () => ctx.idle,
    ui: {
      notifications: [],
      notify(text, level = "info") {
        this.notifications.push({ text, level });
      },
      statuses: [],
      setStatus(key, value) {
        this.statuses.push({ key, value });
      },
      setWidget() {},
      inputCalls: [],
      // Queue of canned answers; shifts one per call. Empty queue ⇒ Esc/undefined.
      input(title, placeholder) {
        this.inputCalls.push({ title, placeholder });
        return Promise.resolve(inputs.length > 0 ? inputs.shift() : undefined);
      },
      confirmCalls: [],
      // Queue of canned answers; shifts one per call. Empty queue ⇒ cancel/false.
      confirm(title, message) {
        this.confirmCalls.push({ title, message });
        return Promise.resolve(confirms.length > 0 ? confirms.shift() : false);
      },
    },
  };
  return ctx;
}

/** Installs a fetch stub; returns calls/queue plus a restore() disposer. */
function stubFetch() {
  const calls = [];
  const queue = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.length > 0 ? queue.shift() : { status: 200, body: HIT_USAGE };
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    queue,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Full capture flow: session_start → headers hook → payload hook. */
async function captureOnce(pi, ctx) {
  await pi.emit("session_start", {}, ctx);
  await pi.emit("before_provider_headers", { headers: HEADERS }, ctx);
  await pi.emit("before_provider_request", { payload: structuredClone(PAYLOAD) }, ctx);
}

async function settle(pi, ctx) {
  await pi.emit("agent_settled", {}, ctx);
}

const lastNotification = (ctx) => ctx.ui.notifications.at(-1)?.text ?? "";

async function shutdown(pi, ctx) {
  await pi.emit("session_shutdown", {}, ctx);
}


// ---------------------------------------------------------------------------
// lib unit tests
// ---------------------------------------------------------------------------

test("parseDurationMs accepts s/m/h/ms and bare minutes", () => {
  assert.equal(lib.parseDurationMs("90s"), 90_000);
  assert.equal(lib.parseDurationMs("4m"), 240_000);
  assert.equal(lib.parseDurationMs("2.5m"), 150_000);
  assert.equal(lib.parseDurationMs("1h"), 3_600_000);
  assert.equal(lib.parseDurationMs("500ms"), 500);
  assert.equal(lib.parseDurationMs("5"), 5 * 60_000);
  assert.equal(lib.parseDurationMs("abc"), null);
  assert.equal(lib.parseDurationMs(""), null);
  assert.equal(lib.parseDurationMs("-4m"), null);
  assert.equal(lib.parseDurationMs("0s"), null);
});

test("parseUsd strips $ and validates", () => {
  assert.equal(lib.parseUsd("$1.5"), 1.5);
  assert.equal(lib.parseUsd("2"), 2);
  assert.equal(lib.parseUsd("0"), 0);
  assert.equal(lib.parseUsd("abc"), null);
  assert.equal(lib.parseUsd("$-1"), null);
});

test("parseUsage reads anthropic-style usage", () => {
  const usage = lib.parseUsage({
    usage: { input_tokens: 52_000, output_tokens: 7, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 200 },
  });
  assert.deepEqual(usage, { inputTokens: 52_000, outputTokens: 7, cacheReadTokens: 50_000, cacheWriteTokens: 200 });
});

test("parseUsage falls back to openai-style fields", () => {
  const usage = lib.parseUsage({
    usage: { prompt_tokens: 9_000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8_000 } },
  });
  assert.equal(usage.inputTokens, 9_000);
  assert.equal(usage.outputTokens, 3);
  assert.equal(usage.cacheReadTokens, 8_000);
  assert.equal(usage.cacheWriteTokens, 0);
});

test("parseUsageFromSse scans usage fragments", () => {
  const text =
    'data: {"usage":{"input_tokens":10}}\ndata: {"usage":{"input_tokens":600,"cache_read_input_tokens":500}}\n';
  const usage = lib.parseUsageFromSse(text);
  assert.equal(usage.inputTokens, 600);
  assert.equal(usage.cacheReadTokens, 500);
});

test("buildProbeHeaders forwards auth, drops hop-by-hop headers", () => {
  const out = lib.buildProbeHeaders(HEADERS);
  assert.equal(out.authorization, "Bearer test-token");
  assert.equal(out["content-type"], "application/json");
  assert.ok(!("content-length" in out));
  assert.ok(!("host" in out));
  assert.ok(!("connection" in out));
});

test("buildProbeHeaders forwards auth, drops hop-by-hop headers", () => {
  const out = lib.buildProbeHeaders(HEADERS);
  assert.equal(out.authorization, "Bearer test-token");
  assert.equal(out["content-type"], "application/json");
  assert.ok(!("content-length" in out));
  assert.ok(!("host" in out));
  assert.ok(!("connection" in out));
});

test("buildProbeBody clamps terminal params and keeps the kimi-openai prefix pristine", () => {
  const { ok, body } = lib.buildProbeBody(PAYLOAD, 16, "kimi-openai-completions", 1);
  assert.equal(ok, true);
  assert.equal(body.max_completion_tokens, 16);
  assert.ok(!("stream" in body));
  assert.ok(!("stream_options" in body));
  assert.ok(!("thinking" in body));
  assert.ok(!("store" in body));
  assert.ok(!("tool_choice" in body));
  // the cache-relevant fields stay untouched
  assert.deepEqual(body.messages, PAYLOAD.messages);
  assert.deepEqual(body.tools, PAYLOAD.tools);
  assert.equal(body.prompt_cache_key, PAYLOAD.prompt_cache_key);
  assert.equal(body.prompt_cache_retention, PAYLOAD.prompt_cache_retention);
  assert.equal(body.temperature, PAYLOAD.temperature);
  assert.equal(body.model, PAYLOAD.model);
});

test("buildProbeBody drops prompt_cache_retention on the fallback attempt", () => {
  const { body } = lib.buildProbeBody(PAYLOAD, 16, "kimi-openai-completions", 2);
  assert.ok(!("prompt_cache_retention" in body));
  assert.equal(body.max_completion_tokens, 16);
});

test("buildProbeBody handles the anthropic-messages dialect", () => {
  const payload = {
    model: "k3",
    stream: true,
    thinking: { type: "enabled", budget_tokens: 2048 },
    system: "You are pi.",
    messages: [{ role: "user", content: "hello" }],
  };
  const first = lib.buildProbeBody(payload, 16, "anthropic-messages", 1);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.body.max_tokens, 16);
    assert.ok(!("stream" in first.body));
    assert.ok(!("thinking" in first.body));
    assert.deepEqual(first.body.tool_choice, { type: "none" });
    assert.deepEqual(first.body.messages, payload.messages);
  }
  const retry = lib.buildProbeBody(payload, 16, "anthropic-messages", 2);
  if (retry.ok) assert.ok(!("tool_choice" in retry.body));
});

test("buildProbeBody rejects malformed payloads", () => {
  assert.equal(lib.buildProbeBody(null, 16, "kimi-openai-completions", 1).ok, false);
  assert.equal(lib.buildProbeBody({ messages: [] }, 16, "kimi-openai-completions", 1).ok, false);
  assert.equal(
    lib.buildProbeBody({ messages: [{ role: "user", content: "x" }], system: 42 }, 16, "kimi-openai-completions", 1).ok,
    false,
  );
});

test("estimateSavedUsd computes the cold-vs-cached delta", () => {
  assert.equal(lib.estimateSavedUsd(50_000, K3_COST), (50_000 / 1e6) * (3 - 0.3));
  assert.equal(lib.estimateSavedUsd(50_000, undefined), 0);
  assert.equal(lib.estimateSavedUsd(0, K3_COST), 0);
});

test("estimateProbeSpendUsd prices cached+uncached+output", () => {
  const usage = { inputTokens: 52_000, outputTokens: 10, cacheReadTokens: 50_000, cacheWriteTokens: 0 };
  const spend = lib.estimateProbeSpendUsd(usage, K3_COST);
  const expected = (50_000 / 1e6) * 0.3 + (2_000 / 1e6) * 3 + (10 / 1e6) * 15;
  assert.ok(Math.abs(spend - expected) < 1e-12);
  assert.equal(lib.estimateProbeSpendUsd(usage, undefined), 0);
});

test("isCacheMiss flags big uncached prompts only", () => {
  assert.equal(lib.isCacheMiss(52_000, 0, 512), true);
  assert.equal(lib.isCacheMiss(52_000, 50_000, 512), false);
  assert.equal(lib.isCacheMiss(100, 0, 512), false); // too small to judge
});

test("formatDuration/formatUsd/formatClock", () => {
  assert.equal(lib.formatDuration(240_000), "4m0s");
  assert.equal(lib.formatDuration(65_000), "1m5s");
  assert.equal(lib.formatDuration(500), "0s");
  assert.equal(lib.formatUsd(1), "$1.00");
  assert.equal(lib.formatUsd(0.0004), "$0.0004");
  assert.equal(lib.formatUsd(0), "$0.00");
  assert.equal(lib.formatClock(null), "--:--:--");
  assert.match(lib.formatClock(Date.now()), /^\d{2}:\d{2}:\d{2}$/);
});

// ---------------------------------------------------------------------------
// integration tests (factory + mock pi + stubbed fetch)
// ---------------------------------------------------------------------------

test("captures a real request and probes on schedule with a clamped body", async (t) => {
  clearHomeState();
  writeState({ enabled: true, intervalMs: 1100, maxIdleMs: 600_000, spendCapUsd: 0, minPromptTokens: 512 });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  factory(pi);
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  await sleep(1_500);

  assert.equal(fetchStub.calls.length, 1);
  const call = fetchStub.calls[0];
  assert.equal(call.url, `${BASE_URL}/chat/completions`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, "Bearer test-token");
  assert.ok(!("content-length" in call.init.headers));
  const body = JSON.parse(call.init.body);
  assert.equal(body.max_completion_tokens, 16);
  assert.ok(!("stream" in body));
  assert.ok(!("stream_options" in body));
  assert.ok(!("thinking" in body));
  assert.ok(!("store" in body));
  assert.ok(!("tool_choice" in body));
  assert.equal(body.prompt_cache_key, PAYLOAD.prompt_cache_key);
  assert.deepEqual(body.messages, PAYLOAD.messages);
  assert.deepEqual(body.tools, PAYLOAD.tools);

  const before = ctx.ui.notifications.length;
  await pi.command("status", ctx);
  const status = ctx.ui.notifications.slice(before).map((n) => n.text).join("\n");
  assert.match(status, /probes:\s*1 \(hits 1/);
  assert.match(status, /saved:\s*\$0\.135/); // 50k × ($3−$0.3)/M
});

test("ticks are skipped while the agent is busy", async (t) => {
  clearHomeState();
  writeState({ enabled: true, intervalMs: 1100, maxIdleMs: 600_000, spendCapUsd: 0, minPromptTokens: 512 });
  const pi = makePi();
  const ctx = makeCtx({ idle: false });
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  factory(pi);
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  await sleep(1_500);
  assert.equal(fetchStub.calls.length, 0);
});

test("probes stop permanently once idle exceeds maxidle", async (t) => {
  clearHomeState();
  writeState({ enabled: true, intervalMs: 1100, maxIdleMs: 1, spendCapUsd: 0, minPromptTokens: 512 });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  factory(pi);
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  await sleep(1_500);
  assert.equal(fetchStub.calls.length, 0);
  assert.match(lastNotification(ctx), /maxidle/);
});

test("a cache miss pauses probing (default miss=1) until the next real turn", async (t) => {
  clearHomeState();
  writeState({ enabled: true, intervalMs: 1100, maxIdleMs: 600_000, spendCapUsd: 0, minPromptTokens: 512 });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  fetchStub.queue.push({ status: 200, body: MISS_USAGE });
  factory(pi);
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  await sleep(2_700);

  assert.equal(fetchStub.calls.length, 1); // second tick suppressed by the pause
  assert.match(lastNotification(ctx), /paused/);

  // A fresh real request clears the sticky pause.
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  // cleared: the stub defaults to HIT usages, so the next tick probes and hits
  await sleep(1_500);
  assert.equal(fetchStub.calls.length, 2);
});

test("HTTP 400 triggers one retry without prompt_cache_retention", async (t) => {
  clearHomeState();
  writeState({ enabled: false, intervalMs: 1100, spendCapUsd: 0, minPromptTokens: 512 });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  fetchStub.queue.push({ status: 400, body: { error: { message: "prompt_cache_retention is not supported in this mode" } } });
  factory(pi);
  await captureOnce(pi, ctx);
  await pi.command("on", ctx);
  await pi.command("now", ctx);

  assert.equal(fetchStub.calls.length, 2);
  assert.equal(fetchStub.calls[0].url, `${BASE_URL}/chat/completions`);
  const retryBody = JSON.parse(fetchStub.calls[1].init.body);
  assert.ok(!("prompt_cache_retention" in retryBody));
  assert.ok(!("tool_choice" in retryBody));
  assert.deepEqual(retryBody.messages, PAYLOAD.messages);
  assert.match(ctx.ui.notifications.map((n) => n.text).join("\n"), /probes:\s*1 \(hits 1/);
});

test("401 pauses immediately", async (t) => {
  clearHomeState();
  writeState({ enabled: false, intervalMs: 1100, spendCapUsd: 0, minPromptTokens: 512 });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  fetchStub.queue.push({ status: 401, body: { error: "unauthorized" } });
  factory(pi);
  await captureOnce(pi, ctx);
  await pi.command("now", ctx);
  assert.equal(fetchStub.calls.length, 1);
  assert.ok(ctx.ui.notifications.some((n) => /paused/.test(n.text)));
});

test("spend cap pauses after a probe exceeds the ceiling", async (t) => {
  clearHomeState();
  // 50k cached tokens at $0.3/M ≈ $0.015/probe → cap below that forces a pause after probe #1.
  writeState({ enabled: true, intervalMs: 1100, maxIdleMs: 600_000, spendCapUsd: 0.01, minPromptTokens: 512 });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  fetchStub.queue.push({ status: 200, body: HIT_USAGE });
  factory(pi);
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  await sleep(1_500);
  assert.equal(fetchStub.calls.length, 1);
  assert.match(lastNotification(ctx), /reached the cap/);
});

test("disabled sessions never probe", async (t) => {
  clearHomeState();
  writeState({ enabled: false });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  factory(pi);
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  await sleep(1_200);
  assert.equal(fetchStub.calls.length, 0);
  await pi.command("status", ctx);
  assert.match(lastNotification(ctx), /state:\s*off/);
  assert.match(lastNotification(ctx), /probes:\s*0/);
});

test("interval below 30s is rejected and persisted settings survive restarts", async (t) => {
  clearHomeState();
  writeState({ enabled: false });
  const pi = makePi();
  const ctx = makeCtx();
  factory(pi);
  await captureOnce(pi, ctx);

  await pi.command("interval=90s", ctx);
  let state = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(state.intervalMs, 90_000);

  await pi.command("interval=5s", ctx);
  state = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(state.intervalMs, 90_000); // unchanged: below the 30s floor
});
// ---------------------------------------------------------------------------
// setup wizard + guardrail settings
// ---------------------------------------------------------------------------

test("first-run wizard fires once on startup, collects guardrails, and can enable", async (t) => {
  clearHomeState();
  const pi = makePi();
  const ctx = makeCtx({
    inputs: ["45m", "3", "5", "0.5", ""], // last: mode (Esc/empty = default)
    confirms: [true, true], // intro confirm + enable confirm
  });
  factory(pi);

  await pi.emit("session_start", { reason: "startup" }, ctx);

  // Five questions in order, each with an explanation in the title.
  assert.equal(ctx.ui.inputCalls.length, 5);
  assert.match(ctx.ui.inputCalls[0].title, /Max idle cutoff/);
  assert.match(ctx.ui.inputCalls[1].title, /Miss pause threshold/);
  assert.match(ctx.ui.inputCalls[2].title, /Error circuit breaker/);
  assert.match(ctx.ui.inputCalls[3].title, /spend cap/i);
  assert.match(ctx.ui.inputCalls[4].title, /Probing mode/);
  assert.ok(ctx.ui.confirmCalls.length >= 2);

  const state = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(state.maxIdleMs, 45 * 60_000);
  assert.equal(state.maxMissStreak, 3);
  assert.equal(state.maxErrorStreak, 5);
  assert.equal(state.spendCapUsd, 0.5);
  assert.equal(state.mode, "default");
  assert.equal(state.enabled, true);
  assert.equal(state.initialized, true);
});

test("cancelling the wizard keeps defaults and never re-asks on the next startup", async (t) => {
  clearHomeState();
  const pi = makePi();
  const ctx = makeCtx({ confirms: [false] }); // decline the intro confirm
  factory(pi);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  assert.equal(ctx.ui.inputCalls.length, 0); // no questions asked after declining

  const saved = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(saved.enabled, false);
  assert.equal(saved.maxIdleMs, 30 * 60_000);
  assert.equal(saved.maxMissStreak, 1);
  assert.equal(saved.maxErrorStreak, 3);
  assert.equal(saved.spendCapUsd, 1.0);
  assert.equal(saved.initialized, true);

  // A second startup with an existing config must not reopen the wizard.
  await pi.emit("session_start", { reason: "startup" }, ctx);
  assert.equal(ctx.ui.inputCalls.length, 0);
});

test("wizard answers persist via miss=/errors= commands and survive restart", async (t) => {
  clearHomeState();
  writeState({ enabled: false });
  const pi = makePi();
  const ctx = makeCtx();
  factory(pi);
  await pi.emit("session_start", {}, ctx);

  await pi.command("miss=5", ctx);
  await pi.command("errors=7", ctx);
  let state = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(state.maxMissStreak, 5);
  assert.equal(state.maxErrorStreak, 7);

  await pi.command("miss=0", ctx);
  await pi.command("errors=abc", ctx);
  state = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(state.maxMissStreak, 5); // unchanged: invalid input rejected
  assert.equal(state.maxErrorStreak, 7); // unchanged: invalid input rejected
});

test("configured error breaker raises the failure tolerance (was hardcoded 3)", async (t) => {
  clearHomeState();
  writeState({ enabled: true, intervalMs: 1100, maxIdleMs: 600_000, maxErrorStreak: 5, spendCapUsd: 0 });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  for (let i = 0; i < 5; i++) fetchStub.queue.push({ status: 500, body: { error: { message: "boom" } } });
  factory(pi);
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  await sleep(6_500);

  assert.equal(fetchStub.calls.length, 5); // 5 ticks needed before the configured breaker fires
  assert.match(lastNotification(ctx), /paused/);
});

// ---------------------------------------------------------------------------
// smart mode

const BIG_INPUT_HIT_USAGE = {
  usage: { input_tokens: 210_000, output_tokens: 4, cache_read_input_tokens: 208_000 },
};

test("mode=smart persists and 5 consecutive hits grow the cadence by 30s", async (t) => {
  clearHomeState();
  writeState({
    enabled: false,
    intervalMs: 8 * 60_000,
    maxIdleMs: 0,
    spendCapUsd: 0,
    minPromptTokens: 512,
    mode: "smart",
  });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  factory(pi);
  await captureOnce(pi, ctx);
  await pi.command("on", ctx);

  // Five floor hits confirm the 8m cadence and promote it to 8m30s.
  for (let i = 0; i < 5; i++) {
    await pi.command("now", ctx);
    await settle(pi, ctx);
    await sleep(20);
  }
  assert.equal(fetchStub.calls.length, 5);
  const persisted = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(persisted.mode, "smart");
  assert.equal(persisted.intervalMs, 8 * 60_000 + 30_000);
});

test("a smart miss parks probing, steps back to the confirmed cadence, and survives a real turn", async (t) => {
  clearHomeState();
  writeState({
    enabled: false,
    intervalMs: 8 * 60_000 + 30_000,
    maxIdleMs: 0,
    spendCapUsd: 0,
    minPromptTokens: 512,
    mode: "smart",
  });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  fetchStub.queue.push({ status: 200, body: MISS_USAGE });
  factory(pi);
  await captureOnce(pi, ctx);

  await pi.command("now", ctx);
  await settle(pi, ctx);
  assert.equal(fetchStub.calls.length, 1);
  const persisted = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(persisted.intervalMs, 8 * 60_000);
  assert.match(lastNotification(ctx), /cache miss in smart mode/);

  // A fresh real turn does NOT resume probing after a smart miss:
  // status still shows the pause and no further probe fires.
  await captureOnce(pi, ctx);
  await settle(pi, ctx);
  await sleep(50);
  assert.equal(fetchStub.calls.length, 1);
  const before = ctx.ui.notifications.length;
  await pi.command("status", ctx);
  const status = ctx.ui.notifications.slice(before).map((n) => n.text).join("\n");
  assert.match(status, /paused: cache miss in smart mode/);
});

test("smart mode parks probing on the first miss and resumes on mode=smart", async (t) => {
  clearHomeState();
  writeState({
    enabled: false,
    intervalMs: 8 * 60_000,
    maxIdleMs: 0,
    spendCapUsd: 0,
    minPromptTokens: 512,
    mode: "smart",
  });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  fetchStub.queue.push({ status: 200, body: MISS_USAGE });
  fetchStub.queue.push({ status: 200, body: MISS_USAGE });
  factory(pi);
  await captureOnce(pi, ctx);

  await pi.command("now", ctx);
  await settle(pi, ctx);
  assert.match(lastNotification(ctx), /cache miss in smart mode/); // a single miss parks probing
  assert.match(lastNotification(ctx), /already at the floor/);
  // Re-selecting smart mode is the documented way to resume probing.
  await pi.command("mode=smart", ctx);
  await settle(pi, ctx);
  await sleep(50);
  assert.ok(!lastNotification(ctx).match(/paused/));
});

test("smart mode freezes growth and reverts to the floor above 200k context", async (t) => {
  clearHomeState();
  writeState({
    enabled: false,
    intervalMs: 8 * 60_000 + 30_000,
    maxIdleMs: 0,
    spendCapUsd: 0,
    minPromptTokens: 512,
    mode: "smart",
  });
  const pi = makePi();
  const ctx = makeCtx();
  const fetchStub = stubFetch();
  t.after(async () => {
    await shutdown(pi, ctx);
    fetchStub.restore();
  });
  fetchStub.queue.push({ status: 200, body: BIG_INPUT_HIT_USAGE });
  fetchStub.queue.push({ status: 200, body: BIG_INPUT_HIT_USAGE });
  factory(pi);
  await captureOnce(pi, ctx);

  // First big hit reverts above-floor cadence to the floor…
  await pi.command("now", ctx);
  await settle(pi, ctx);
  let persisted = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(persisted.intervalMs, 8 * 60_000);
  // …and further big-context hits never re-promote it.
  await pi.command("now", ctx);
  await settle(pi, ctx);
  await pi.command("now", ctx);
  await settle(pi, ctx);
  await pi.command("now", ctx);
  await settle(pi, ctx);
  persisted = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(persisted.intervalMs, 8 * 60_000);
});

test("interval= is rejected while smart mode manages the cadence", async (t) => {
  clearHomeState();
  writeState({
    enabled: false,
    intervalMs: 8 * 60_000,
    maxIdleMs: 0,
    spendCapUsd: 0,
    minPromptTokens: 512,
    mode: "smart",
  });
  const pi = makePi();
  const ctx = makeCtx();
  factory(pi);
  await captureOnce(pi, ctx);
  await pi.command("interval=9m", ctx);
  const persisted = JSON.parse(readFileSync(statePath(), "utf8"));
  assert.equal(persisted.intervalMs, 8 * 60_000);
  assert.match(lastNotification(ctx), /smart mode manages the cadence/);
});
