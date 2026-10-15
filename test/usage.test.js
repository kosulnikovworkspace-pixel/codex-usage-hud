const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const client = require("../src/usage-client.js");
const format = require("../src/format.js");

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const windowValue = (seconds, used) => ({ limit_window_seconds: seconds, used_percent: used, reset_at: 1_800_000_000 });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function mockRequests({ session = { accessToken: "test-token", account: { id: "account-1" } }, quota, quotaStatus = 200 }) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/auth/session")) return response(session);
    if (url.endsWith("/wham/usage")) return response(quota, quotaStatus);
    throw new Error("Unexpected request");
  };
  return calls;
}

test("maps 5h and weekly quota windows by duration", () => {
  assert.deepEqual(client.parseLimits({ rate_limit: {
    primary_window: windowValue(18000, 30),
    secondary_window: windowValue(604800, 5)
  } }), {
    fiveHour: { usedPercent: 30, resetAt: "2027-01-15T08:00:00.000Z" },
    weekly: { usedPercent: 5, resetAt: "2027-01-15T08:00:00.000Z" }
  });
});

test("maps a primary weekly window without inventing 5h data", () => {
  assert.deepEqual(client.parseLimits({ rate_limit: { primary_window: windowValue(604800, 20) } }), {
    fiveHour: null,
    weekly: { usedPercent: 20, resetAt: "2027-01-15T08:00:00.000Z" }
  });
});

test("finds additional windows and tolerates a missing secondary window", () => {
  assert.deepEqual(client.parseLimits({
    rate_limit: { primary_window: windowValue(18000, 40) },
    additional_rate_limits: [{ rate_limit: { primary_window: windowValue(604800, 15) } }]
  }), {
    fiveHour: { usedPercent: 40, resetAt: "2027-01-15T08:00:00.000Z" },
    weekly: { usedPercent: 15, resetAt: "2027-01-15T08:00:00.000Z" }
  });
  assert.equal(client.parseLimits({ rate_limit: { primary_window: windowValue(18000, 40) } }).weekly, null);
});

test("rejects malformed, unlabelled, and out-of-range quota values", () => {
  assert.equal(client.parseLimits(null), null);
  assert.equal(client.parseLimits({ rate_limit: { primary_window: { used_percent: 34 } } }), null);
  assert.equal(client.parseLimits({ rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: "34" } } }), null);
  assert.equal(client.parseLimits({ rate_limit: { primary_window: windowValue(18000, 101) } }).fiveHour.usedPercent, null);
});

test("formats percentages and reset values safely", () => {
  assert.equal(format.percent(30.4), "30%");
  assert.equal(format.percent(null), "—");
  assert.equal(format.percent(-1), "—");
  assert.equal(format.percent(101), "—");
  assert.equal(format.validPercent(NaN), false);
  const now = Date.parse("2026-10-15T10:00:00Z");
  assert.equal(format.reset("2026-10-15T12:17:00Z", now), "02:17");
  assert.equal(format.reset("2026-10-19T22:00:00Z", now), "4d 12h");
  assert.equal(format.reset(null, now), "—");
});

test("loadUsage makes only session and quota requests with a temporary token", async () => {
  const calls = mockRequests({ quota: { rate_limit: {
    primary_window: windowValue(18000, 30),
    secondary_window: windowValue(604800, 5)
  } } });
  const result = await client.loadUsage(new Date(2026, 9, 15, 12).getTime());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-token");
  assert.equal(calls[1].options.headers["ChatGPT-Account-Id"], "account-1");
  assert.deepEqual(Object.keys(result.snapshot).sort(), ["fiveHour", "updatedAt", "weekly"]);
  assert.equal(JSON.stringify(result).includes("test-token"), false);
  assert.deepEqual(result.diagnostics, []);
});

test("session and quota failures return safe diagnostics", async () => {
  mockRequests({ session: { user: { name: "Example" } } });
  const missingSession = await client.loadUsage();
  assert.equal(missingSession.snapshot, null);
  assert.equal(missingSession.diagnostics[0].code, "NO_ACCESS_TOKEN");
  const calls = mockRequests({ quotaStatus: 403 });
  const quotaFailure = await client.loadUsage();
  assert.equal(calls.length, 2);
  assert.equal(quotaFailure.snapshot, null);
  assert.equal(quotaFailure.diagnostics[0].stage, "quota");
  assert.equal(quotaFailure.diagnostics[0].status, 403);
});

test("unrecognized quota response remains unavailable", async () => {
  mockRequests({ quota: { rate_limit: {} } });
  const result = await client.loadUsage();
  assert.equal(result.snapshot, null);
  assert.equal(result.diagnostics[0].code, "QUOTA_UNRECOGNIZED");
});
