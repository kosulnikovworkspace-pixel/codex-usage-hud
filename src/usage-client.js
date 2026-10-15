/* Access to ChatGPT's undocumented usage endpoints lives in this file. */
(() => {
  "use strict";

  const ORIGIN = "https://chatgpt.com";
  const SESSION_URL = `${ORIGIN}/api/auth/session`;
  const USAGE_URL = `${ORIGIN}/backend-api/wham/usage`;
  const DAILY_URL = `${ORIGIN}/backend-api/wham/analytics/daily-workspace-usage-counts`;
  const TIMEOUT_MS = 15000;
  const FIVE_HOURS = 5 * 60 * 60;
  const ONE_WEEK = 7 * 24 * 60 * 60;

  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
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
    const result = { fiveHour: null, weekly: null };
    const seen = new Set();
    function visit(value, depth) {
      if (depth > 5 || value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      const seconds = number(value.limit_window_seconds ?? value.limitWindowSeconds);
      const data = windowData(value);
      if (seconds !== null && data) {
        if (Math.abs(seconds - FIVE_HOURS) <= 60 && !result.fiveHour) result.fiveHour = data;
        if (Math.abs(seconds - ONE_WEEK) <= 60 && !result.weekly) result.weekly = data;
      }
      for (const key of ["rate_limit", "rateLimit", "codex_rate_limit", "primary_window", "primaryWindow",
        "secondary_window", "secondaryWindow", "additional_rate_limits", "additionalRateLimits"]) {
        visit(value[key], depth + 1);
      }
    }
    visit(payload, 0);
    return result.fiveHour || result.weekly ? result : null;
  }

  function localDay(now) {
    const d = new Date(now);
    if (!Number.isFinite(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function nextLocalDay(now) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return localDay(d.getTime());
  }

  function rowDay(value) {
    if (typeof value !== "string") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? localDay(timestamp) : null;
  }

  function dailyRecords(payload) {
    if (Array.isArray(payload)) return payload;
    if (!object(payload)) return null;
    for (const source of [payload, payload.data]) {
      if (!object(source)) continue;
      for (const key of ["data", "daily_usage", "dailyUsage", "daily_counts", "dailyCounts", "records", "items", "results"]) {
        if (Array.isArray(source[key])) return source[key];
      }
    }
    return null;
  }

  function tokenCount(source) {
    if (!object(source)) return null;
    const tokenNumber = (value) => {
      const candidate = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : number(value);
      return candidate !== null && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
    };
    const total = tokenNumber(source.text_total_tokens ?? source.total_tokens ?? source.totalTokens ??
      source.token_count ?? source.tokenCount ?? source.tokens);
    const uncached = tokenNumber(source.uncached_text_input_tokens);
    const cached = tokenNumber(source.cached_text_input_tokens);
    const output = tokenNumber(source.text_output_tokens);
    if ([uncached, cached, output].some((value) => value === null)) return total;
    const sum = uncached + cached + output;
    if (total !== null && total > 0) return total;
    return Number.isSafeInteger(sum) ? sum : total;
  }

  function dailyRecord(row) {
    if (!object(row)) return null;
    const day = rowDay(row.date ?? row.day ?? row.usage_date ?? row.usageDate ?? row.bucket_date);
    if (!day) return null;
    const product = row.product_surface ?? row.productSurface ?? row.product;
    if (typeof product === "string" && !/codex/i.test(product)) return null;
    for (const source of [row.totals, row.usage, row.token_usage, row]) {
      const tokens = tokenCount(source);
      if (tokens !== null) return { day, tokens };
    }
    return null;
  }

  function parseToday(payload, now = Date.now()) {
    const day = localDay(now);
    const rows = dailyRecords(payload);
    if (!day || !rows) return null;
    let tokens = 0;
    let found = false;
    for (const row of rows) {
      const record = dailyRecord(row);
      if (!record || record.day !== day) continue;
      if (!Number.isSafeInteger(tokens + record.tokens)) return null;
      tokens += record.tokens;
      found = true;
    }
    return found ? { tokens, day } : null;
  }

  function analyticsSchema(payload) {
    const rootKeys = object(payload) ? Object.keys(payload).slice(0, 32) : [];
    const rows = dailyRecords(payload);
    const safeKeys = (keys) => keys.map((key) => key.slice(0, 80));
    return {
      httpStatus: 200,
      isArray: Array.isArray(payload),
      rootType: payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload,
      rootKeys: safeKeys(rootKeys),
      rootFieldTypes: Object.fromEntries(rootKeys.map((key) => [key.slice(0, 80),
        payload[key] === null ? "null" : Array.isArray(payload[key]) ? "array" : typeof payload[key]])),
      firstRecordKeys: object(rows?.[0]) ? safeKeys(Object.keys(rows[0]).slice(0, 32)) : [],
      at: new Date().toISOString()
    };
  }

  function diagnostic(stage, code, status = null) {
    return { stage, status, code, at: new Date().toISOString() };
  }

  // Never attach the response body or request headers to an error.
  function requestError(stage, code, status = null) {
    return { diagnostic: diagnostic(stage, code, status) };
  }

  async function requestJson(url, stage, auth = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const headers = { Accept: "application/json" };
    if (auth) {
      headers.Authorization = `Bearer ${auth.accessToken}`;
      if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
    }
    try {
      let response;
      try {
        response = await fetch(url, {
          credentials: "include", cache: "no-store", headers, signal: controller.signal
        });
      } catch (error) {
        throw requestError(stage, error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR");
      }
      if (!response.ok) throw requestError(stage, "HTTP_ERROR", response.status);
      try {
        return await response.json();
      } catch (_) {
        throw requestError(stage, "INVALID_JSON");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  function sessionAuth(payload) {
    if (!object(payload)) return null;
    const accessToken = payload.accessToken ?? payload.access_token;
    if (typeof accessToken !== "string" || !accessToken.trim()) return null;
    const candidate = payload.account?.id ?? payload.accountId ?? payload.account_id;
    const accountId = typeof candidate === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(candidate)
      ? candidate : null;
    return { accessToken, accountId };
  }

  function dailyUrl(now) {
    const url = new URL(DAILY_URL);
    url.searchParams.set("start_date", localDay(now));
    url.searchParams.set("end_date", nextLocalDay(now)); // Exclusive end date.
    url.searchParams.set("group_by", "day");
    return url.toString();
  }

  async function loadUsage(now = Date.now()) {
    const diagnostics = [];
    let auth;
    try {
      auth = sessionAuth(await requestJson(SESSION_URL, "session"));
      if (!auth) throw requestError("session", "NO_ACCESS_TOKEN");
    } catch (error) {
      diagnostics.push(error?.diagnostic ?? diagnostic("session", "UNKNOWN_ERROR"));
      return { snapshot: null, diagnostics };
    }

    // Both sources settle independently; a failed analytics request cannot hide quota data.
    const [quotaResult, analyticsResult] = await Promise.allSettled([
      requestJson(USAGE_URL, "quota", auth),
      requestJson(dailyUrl(now), "analytics", auth)
    ]);
    // Drop our explicit reference to the token before returning any result.
    auth = null;

    let limits = null;
    if (quotaResult.status === "fulfilled") {
      limits = parseLimits(quotaResult.value);
      if (!limits) diagnostics.push(diagnostic("parsing", "QUOTA_UNRECOGNIZED"));
    } else {
      diagnostics.push(quotaResult.reason?.diagnostic ?? diagnostic("quota", "UNKNOWN_ERROR"));
    }

    let today = null;
    if (analyticsResult.status === "fulfilled") {
      today = parseToday(analyticsResult.value, now);
      if (!today) {
        diagnostics.push(diagnostic("parsing", "ANALYTICS_UNRECOGNIZED"));
        console.warn("[Codex Usage HUD] analytics schema:", analyticsSchema(analyticsResult.value));
      }
    } else {
      diagnostics.push(analyticsResult.reason?.diagnostic ?? diagnostic("analytics", "UNKNOWN_ERROR"));
    }

    return {
      snapshot: limits || today ? {
        fiveHour: limits?.fiveHour ?? null,
        weekly: limits?.weekly ?? null,
        today,
        updatedAt: new Date(now).toISOString()
      } : null,
      diagnostics
    };
  }

  const client = { loadUsage, parseLimits, parseToday, resetTime, dailyUrl };
  globalThis.CodexUsageClient = client;
  if (typeof module !== "undefined" && module.exports) module.exports = client;
})();
