(() => {
  "use strict";

  const validPercent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  const percent = (value) => validPercent(value) ? `${Math.round(value)}%` : "—";

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

  const format = { validPercent, percent, reset };
  globalThis.CodexUsageFormat = format;
  if (typeof module !== "undefined" && module.exports) module.exports = format;
})();
