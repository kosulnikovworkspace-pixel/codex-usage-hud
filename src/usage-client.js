/* Access to ChatGPT's undocumented usage endpoints lives in this file. */
(() => {
  "use strict";

  const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
  const DAILY_URL = "https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts";
  const TIMEOUT_MS = 15000;

  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const firstObject = (...values) => values.find(object) || null;
  const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

  function percent(value) {
    const n = number(value);
    return n !== null && n >= 0 && n <= 100 ? n : null;
  }

  function resetTime(value) {
    if (value === null || value === undefined) return null;
    let ms;
    if (typeof value === "number" && Number.isFinite(value)) {
      ms = value < 1e11 ? value * 1000 : value;
    } else if (typeof value === "string" && value.trim()) {
      ms = Date.parse(value);
    } else {
      return null;
    }
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  }

  function windowData(value) {
    if (!object(value)) return null;
    const usedPercent = percent(value.used_percent ?? value.usedPercent);
    const resetAt = resetTime(value.reset_at ?? value.resetAt);
    return usedPercent !== null || resetAt !== null ? { usedPercent, resetAt } : null;
  }

  function parseLimits(payload) {
    if (!object(payload)) return null;
    for (const rate of [payload.rate_limit, payload.rateLimit, payload.codex_rate_limit, payload]) {
      if (!object(rate)) continue;
      const fiveHour = windowData(rate.primary_window ?? rate.primaryWindow ?? rate.five_hour ?? rate.fiveHour);
      const weekly = windowData(rate.secondary_window ?? rate.secondaryWindow ?? rate.weekly_window ?? rate.weekly);
      if (fiveHour || weekly) return { fiveHour, weekly };
    }
    return null;
  }

  function localDay(now) {
    const d = new Date(now);
    if (!Number.isFinite(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function rowDay(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
    return match ? match[1] : null;
  }

  function tokenCount(row) {
    const usage = firstObject(row.usage, row.token_usage);
    for (const source of [row, usage]) {
      if (!source) continue;
      const n = number(source.total_tokens ?? source.totalTokens ?? source.token_count ?? source.tokenCount ?? source.tokens);
      if (n !== null && n >= 0 && Number.isSafeInteger(n)) return n;
    }
    return null;
  }

  function parseToday(payload, now = Date.now()) {
    if (!object(payload) && !Array.isArray(payload)) return null;
    const day = localDay(now);
    if (!day) return null;
    const rows = [payload, payload.daily_usage, payload.dailyUsage, payload.daily_counts, payload.dailyCounts,
      payload.data, payload.items, payload.results].find(Array.isArray);
    if (!rows) return null;

    let tokens = 0;
    let found = false;
    for (const row of rows) {
      if (!object(row) || rowDay(row.date ?? row.day ?? row.usage_date ?? row.usageDate ?? row.bucket_date) !== day) continue;
      const product = row.product_surface ?? row.productSurface ?? row.product;
      if (typeof product === "string" && !/codex/i.test(product)) continue;
      const count = tokenCount(row);
      if (count === null || !Number.isSafeInteger(tokens + count)) continue;
      tokens += count;
      found = true;
    }
    return found ? { tokens, day } : null;
  }

  async function requestJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Usage request failed");
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadUsage(now = Date.now()) {
    const [limitsResult, dailyResult] = await Promise.allSettled([
      requestJson(USAGE_URL), requestJson(DAILY_URL)
    ]);
    const limits = limitsResult.status === "fulfilled" ? parseLimits(limitsResult.value) : null;
    const today = dailyResult.status === "fulfilled" ? parseToday(dailyResult.value, now) : null;
    if (!limits && !today) throw new Error("Usage data unavailable");
    return {
      snapshot: {
        fiveHour: limits?.fiveHour ?? null,
        weekly: limits?.weekly ?? null,
        today,
        updatedAt: new Date(now).toISOString()
      },
      partial: !limits || !today || limitsResult.status === "rejected" || dailyResult.status === "rejected"
    };
  }

  const client = { loadUsage, parseLimits, parseToday, resetTime };
  globalThis.CodexUsageClient = client;
  if (typeof module !== "undefined" && module.exports) module.exports = client;
})();
