const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const client = require("../src/usage-client.js");
const format = require("../src/format.js");

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const windowValue = (seconds, used) => ({ limit_window_seconds: seconds, used_percent: used, reset_at: 1_800_000_000 });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function mockRequests({ session = { accessToken: "test-token", account: { id: "account-1" } }, quota, analytics, quotaStatus = 200, analyticsStatus = 200 }) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/auth/session")) return response(session);
    if (url.endsWith("/wham/usage")) return response(quota, quotaStatus);
    return response(analytics, analyticsStatus);
  };
  return calls;
}

test("maps primary 5h and secondary weekly windows by duration", () => {
  const limits = client.parseLimits({ rate_limit: {
    primary_window: windowValue(18000, 34.4),
    secondary_window: windowValue(604800, 18)
  } });
  assert.deepEqual(limits, {
    fiveHour: { usedPercent: 34.4, resetAt: "2027-01-15T08:00:00.000Z" },
    weekly: { usedPercent: 18, resetAt: "2027-01-15T08:00:00.000Z" }
  });
});

test("maps a primary weekly window without inventing a 5h value", () => {
  assert.deepEqual(client.parseLimits({ rate_limit: { primary_window: windowValue(604800, 20) } }), {
    fiveHour: null,
    weekly: { usedPercent: 20, resetAt: "2027-01-15T08:00:00.000Z" }
  });
});

test("finds additional limits and tolerates a missing secondary window", () => {
  assert.deepEqual(client.parseLimits({
    rate_limit: { primary_window: windowValue(18000, 40) },
    additional_rate_limits: [{ rate_limit: { primary_window: windowValue(604800, 15) } }]
  }), {
    fiveHour: { usedPercent: 40, resetAt: "2027-01-15T08:00:00.000Z" },
    weekly: { usedPercent: 15, resetAt: "2027-01-15T08:00:00.000Z" }
  });
  assert.equal(client.parseLimits({ rate_limit: { primary_window: windowValue(18000, 40) } }).weekly, null);
});

test("rejects malformed and unlabelled rate windows", () => {
  assert.equal(client.parseLimits(null), null);
  assert.equal(client.parseLimits({ rate_limit: { primary_window: { used_percent: 34 } } }), null);
  assert.equal(client.parseLimits({ rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: "34" } } }), null);
});

test("analytics parser counts only valid Codex token rows for today", () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const day = client.parseToday([{ date: "2026-10-15", total_tokens: 1 }], now).day;
  assert.deepEqual(client.parseToday({ data: [
    { date: day, product: "codex", total_tokens: 400 },
    { date: day, product: "codex", usage: { total_tokens: 28 } },
    { date: day, product: "chat", total_tokens: 999 },
    { date: "2026-10-14", product: "codex", total_tokens: 100 },
    { date: day, product: "codex", total_tokens: "50" }
  ] }, now), { tokens: 428, day });
  assert.equal(client.parseToday({ data: [{ date: day, request_count: 10 }] }, now), null);
  assert.equal(client.parseToday({}, now), null);
  const url = new URL(client.dailyUrl(now));
  assert.equal(url.searchParams.get("start_date"), day);
  assert.equal(url.searchParams.get("group_by"), "day");
  assert.equal(url.searchParams.get("end_date"), "2026-10-16");
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
});

test("session token stays in request memory; quota survives analytics HTTP error", async () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const calls = mockRequests({
    quota: { rate_limit: { primary_window: windowValue(18000, 25) } },
    analyticsStatus: 400
  });
  const result = await client.loadUsage(now);
  assert.equal(result.snapshot.fiveHour.usedPercent, 25);
  assert.equal(result.snapshot.today, null);
  assert.deepEqual(result.diagnostics.map(({ stage, status, code }) => ({ stage, status, code })), [
    { stage: "analytics", status: 400, code: "HTTP_ERROR" }
  ]);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-token");
  assert.equal(calls[1].options.headers["ChatGPT-Account-Id"], "account-1");
  assert.equal(calls[2].options.headers.Authorization, "Bearer test-token");
  assert.equal(JSON.stringify(result).includes("test-token"), false);
});

test("analytics survives quota HTTP error", async () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const day = client.parseToday([{ date: "2026-10-15", total_tokens: 1 }], now).day;
  mockRequests({ quotaStatus: 403, analytics: { data: [{ date: day, total_tokens: 1234 }] } });
  const result = await client.loadUsage(now);
  assert.equal(result.snapshot.fiveHour, null);
  assert.equal(result.snapshot.today.tokens, 1234);
  assert.equal(result.diagnostics[0].stage, "quota");
  assert.equal(result.diagnostics[0].status, 403);
});

test("combines quota and analytics when both endpoints succeed", async () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const day = client.parseToday([{ date: "2026-10-15", total_tokens: 1 }], now).day;
  mockRequests({
    quota: { rate_limit: { primary_window: windowValue(18000, 50), secondary_window: windowValue(604800, 10) } },
    analytics: { daily_usage: [{ date: day, total_tokens: 1234 }] }
  });
  const result = await client.loadUsage(now);
  assert.equal(result.snapshot.fiveHour.usedPercent, 50);
  assert.equal(result.snapshot.weekly.usedPercent, 10);
  assert.equal(result.snapshot.today.tokens, 1234);
  assert.deepEqual(result.diagnostics, []);
});

test("missing session token and two failed sources return safe diagnostics", async () => {
  mockRequests({ session: { user: { name: "Example" } } });
  const sessionResult = await client.loadUsage();
  assert.equal(sessionResult.snapshot, null);
  assert.equal(sessionResult.diagnostics[0].code, "NO_ACCESS_TOKEN");
  mockRequests({ quotaStatus: 401, analyticsStatus: 400 });
  const result = await client.loadUsage();
  assert.equal(result.snapshot, null);
  assert.deepEqual(result.diagnostics.map((item) => item.stage), ["quota", "analytics"]);
});
