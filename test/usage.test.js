const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const client = require("../src/usage-client.js");
const format = require("../src/format.js");

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test("normalizes known rate limit windows and ignores invalid values", () => {
  assert.deepEqual(client.parseLimits({ rate_limit: {
    primary_window: { used_percent: 34.4, reset_at: 1_800_000_000 },
    secondary_window: { used_percent: 18, reset_at: "invalid" }
  } }), {
    fiveHour: { usedPercent: 34.4, resetAt: "2027-01-15T08:00:00.000Z" },
    weekly: { usedPercent: 18, resetAt: null }
  });
  assert.equal(client.parseLimits({ rate_limit: { primary_window: { used_percent: "34" } } }), null);
  assert.equal(client.parseLimits({ rate_limit: {}, codex_rate_limit: { primary_window: { used_percent: 5 } } }).fiveHour.usedPercent, 5);
  assert.equal(client.parseLimits(null), null);
});

test("daily parser counts only dated token values for Codex", () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const day = `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, "0")}-${String(new Date(now).getDate()).padStart(2, "0")}`;
  assert.deepEqual(client.parseToday({ data: [
    { date: day, product: "codex", total_tokens: 400 },
    { date: day, product: "codex", usage: { total_tokens: 28 } },
    { date: day, product: "chat", total_tokens: 999 },
    { date: "2026-10-14", product: "codex", total_tokens: 100 },
    { date: day, product: "codex", total_tokens: "50" }
  ] }, now), { tokens: 428, day });
  assert.equal(client.parseToday({ data: [{ date: day, request_count: 10 }] }, now), null);
  assert.equal(client.parseToday({}, now), null);
});

test("formats missing values, compact tokens, and resets", () => {
  assert.equal(format.percent(34.4), "34%");
  assert.equal(format.percent("34"), "—");
  assert.equal(format.tokens(428000), "428K");
  assert.equal(format.tokens(undefined), "—");
  const now = Date.parse("2026-10-15T10:00:00Z");
  assert.equal(format.reset("2026-10-15T12:17:00Z", now), "02:17");
  assert.equal(format.reset("2026-10-19T22:00:00Z", now), "4d 12h");
  assert.equal(format.reset(null, now), "—");
  assert.equal(format.reset("2026-10-15T09:00:00Z", now), "Soon");
});

test("loadUsage accepts partial data and rejects fully unusable responses", async () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  global.fetch = async (url) => ({
    ok: true,
    json: async () => url.endsWith("/usage")
      ? { rate_limit: { primary_window: { used_percent: 25 } } }
      : { unknown: true }
  });
  const result = await client.loadUsage(now);
  assert.equal(result.partial, true);
  assert.equal(result.snapshot.fiveHour.usedPercent, 25);
  assert.equal(result.snapshot.today, null);
  global.fetch = async () => ({ ok: false });
  await assert.rejects(client.loadUsage(now), /Usage data unavailable/);
});

test("loadUsage combines both usable responses", async () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const day = client.parseToday([{ date: "2026-10-15", total_tokens: 1 }], now).day;
  global.fetch = async (url) => ({
    ok: true,
    json: async () => url.endsWith("/usage")
      ? { rate_limit: { primary_window: { used_percent: 50 }, secondary_window: { used_percent: 10 } } }
      : { daily_usage: [{ date: day, total_tokens: 1234 }] }
  });
  const result = await client.loadUsage(now);
  assert.equal(result.partial, false);
  assert.equal(result.snapshot.weekly.usedPercent, 10);
  assert.equal(result.snapshot.today.tokens, 1234);
});
