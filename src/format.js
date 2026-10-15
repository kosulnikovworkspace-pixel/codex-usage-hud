(() => {
  "use strict";

  const validPercent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  const percent = (value) => validPercent(value) ? `${Math.round(value)}%` : "—";

  function tokens(value) {
    if (!Number.isSafeInteger(value) || value < 0) return "—";
    if (value < 1000) return String(value);
    if (value < 1e6) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0).replace(/\.0$/, "")}K`;
    return `${(value / 1e6).toFixed(value < 1e7 ? 1 : 0).replace(/\.0$/, "")}M`;
  }

  function reset(value, now = Date.now()) {
    if (typeof value !== "string") return "—";
    const remaining = Date.parse(value) - now;
    if (!Number.isFinite(remaining)) return "—";
    if (remaining <= 0) return "Soon";
    const minutes = Math.ceil(remaining / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    return days ? `${days}d ${hours}h` : `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  }

  const format = { validPercent, percent, tokens, reset };
  globalThis.CodexUsageFormat = format;
  if (typeof module !== "undefined" && module.exports) module.exports = format;
})();
