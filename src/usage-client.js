/* Access to ChatGPT's undocumented usage endpoints lives in this file. */
(() => {
  "use strict";

  const ORIGIN = "https://chatgpt.com";
  const SESSION_URL = `${ORIGIN}/api/auth/session`;
  const USAGE_URL = `${ORIGIN}/backend-api/wham/usage`;
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

    let quota;
    try {
      quota = await requestJson(USAGE_URL, "quota", auth);
    } catch (error) {
      auth = null;
      diagnostics.push(error?.diagnostic ?? diagnostic("quota", "UNKNOWN_ERROR"));
      return { snapshot: null, diagnostics };
    }
    // Drop our explicit reference to the token before returning any result.
    auth = null;

    const limits = parseLimits(quota);
    if (!limits) diagnostics.push(diagnostic("parsing", "QUOTA_UNRECOGNIZED"));

    return {
      snapshot: limits ? {
        fiveHour: limits.fiveHour,
        weekly: limits.weekly,
        updatedAt: new Date(now).toISOString()
      } : null,
      diagnostics
    };
  }

  const client = { loadUsage, parseLimits, resetTime };
  globalThis.CodexUsageClient = client;
  if (typeof module !== "undefined" && module.exports) module.exports = client;
})();
