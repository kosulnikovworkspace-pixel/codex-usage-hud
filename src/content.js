(() => {
  "use strict";

  if (globalThis.__codexUsageHudStarted) return;
  globalThis.__codexUsageHudStarted = true;

  const ID = "codex-usage-hud";
  const STATE_KEY = "codexUsageHudStateV1";
  const REFRESH_MS = 5 * 60 * 1000;
  let snapshot = null;
  let collapsed = false;
  let loading = false;
  let status = "Loading usage…";
  let requestInFlight = null;
  let pendingSave = Promise.resolve();
  const format = globalThis.CodexUsageFormat;

  function element(tag, className, parent, label = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label) node.textContent = label;
    parent.appendChild(node);
    return node;
  }

  // A stale node can remain after an extension reload in the same tab.
  document.getElementById(ID)?.remove();
  const hud = element("section", "codex-hud", document.body);
  hud.id = ID;
  hud.setAttribute("aria-label", "Codex usage");
  const header = element("div", "codex-hud__header", hud);
  const title = element("strong", "codex-hud__title", header, "CODEX USAGE");
  const actions = element("div", "codex-hud__actions", header);
  const refreshButton = element("button", "codex-hud__button", actions, "↻");
  refreshButton.type = "button";
  refreshButton.title = "Refresh usage";
  refreshButton.setAttribute("aria-label", "Refresh usage");
  const toggleButton = element("button", "codex-hud__button", actions, "−");
  toggleButton.type = "button";
  const compact = element("span", "codex-hud__compact", header);
  const details = element("div", "codex-hud__details", hud);
  const rows = {};

  function metric(label) {
    const group = element("div", "codex-hud__limit", details);
    const row = element("div", "codex-hud__metric", group);
    element("span", "codex-hud__label", row, label);
    const value = element("strong", "codex-hud__value", row);
    const track = element("div", "codex-hud__track", group);
    const fill = element("div", "codex-hud__fill", track);
    const reset = element("span", "codex-hud__reset", group);
    return { value, track, fill, reset };
  }

  rows.fiveHour = metric("5H");
  rows.weekly = metric("WEEK");
  const footer = element("div", "codex-hud__footer", details);
  rows.updated = element("span", "", footer);
  rows.status = element("span", "codex-hud__status", details);
  rows.status.setAttribute("role", "status");
  rows.status.setAttribute("aria-live", "polite");

  function quotaSnapshot(value) {
    if (!value || typeof value !== "object") return null;
    return {
      fiveHour: value.fiveHour ?? null,
      weekly: value.weekly ?? null,
      updatedAt: value.updatedAt ?? null
    };
  }

  function setMetric(row, window) {
    const value = window?.usedPercent;
    row.value.textContent = format.percent(value);
    row.track.hidden = !format.validPercent(value);
    row.fill.style.width = format.validPercent(value) ? `${value}%` : "0%";
    const reset = format.reset(window?.resetAt);
    row.reset.textContent = reset === "—" ? "Reset unavailable" : reset === "Soon" ? "Reset soon" : `Reset in ${reset}`;
  }

  function render() {
    hud.classList.toggle("codex-hud--collapsed", collapsed);
    details.hidden = collapsed;
    title.textContent = collapsed ? "Codex" : "CODEX USAGE";
    compact.textContent = `5h ${format.percent(snapshot?.fiveHour?.usedPercent)} · Week ${format.percent(snapshot?.weekly?.usedPercent)}`;
    compact.hidden = !collapsed;
    refreshButton.hidden = collapsed;
    refreshButton.disabled = loading;
    refreshButton.classList.toggle("codex-hud__button--loading", loading);
    toggleButton.textContent = collapsed ? "+" : "−";
    toggleButton.title = collapsed ? "Expand usage" : "Collapse usage";
    toggleButton.setAttribute("aria-label", toggleButton.title);
    setMetric(rows.fiveHour, snapshot?.fiveHour);
    setMetric(rows.weekly, snapshot?.weekly);
    const updated = snapshot?.updatedAt && Date.parse(snapshot.updatedAt);
    rows.updated.textContent = Number.isFinite(updated) ? `Updated ${new Date(updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Not updated yet";
    rows.status.textContent = status;
    rows.status.hidden = !status;
  }

  function storageGet() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(STATE_KEY, (items) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(items[STATE_KEY]);
      });
    });
  }

  function storageSet() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STATE_KEY]: { collapsed, snapshot } }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  }

  function persist() {
    pendingSave = pendingSave.catch(() => {}).then(storageSet);
    return pendingSave;
  }

  function refresh() {
    if (requestInFlight) return requestInFlight;
    loading = true;
    status = snapshot ? "Refreshing…" : "Loading usage…";
    render();
    requestInFlight = globalThis.CodexUsageClient.loadUsage()
      .then((result) => {
        if (result.diagnostics.length) {
          // Diagnostics contain only stage, status, code, and timestamp.
          console.warn("[Codex Usage HUD]", result.diagnostics);
        }
        if (!result.snapshot) {
          status = snapshot ? "Last update failed · showing saved data" : "Usage data unavailable";
          return;
        }
        snapshot = {
          fiveHour: result.snapshot.fiveHour ?? snapshot?.fiveHour ?? null,
          weekly: result.snapshot.weekly ?? snapshot?.weekly ?? null,
          updatedAt: result.snapshot.updatedAt
        };
        status = "";
        return persist().catch(() => {});
      })
      .catch(() => {
        const detail = { stage: "parsing", status: null, code: "UNEXPECTED_ERROR", at: new Date().toISOString() };
        console.warn("[Codex Usage HUD]", [detail]);
        status = snapshot ? "Last update failed · showing saved data" : "Usage data unavailable";
      })
      .finally(() => {
        loading = false;
        requestInFlight = null;
        render();
      });
    return requestInFlight;
  }

  refreshButton.addEventListener("click", refresh);
  toggleButton.addEventListener("click", () => {
    collapsed = !collapsed;
    render();
    persist().catch(() => {});
  });

  async function start() {
    try {
      const saved = await storageGet();
      if (saved && typeof saved === "object") {
        collapsed = saved.collapsed === true;
        snapshot = quotaSnapshot(saved.snapshot);
      }
    } catch (_) {
      // Storage can be unavailable during an extension reload; live data still works.
    }
    render();
    refresh();
    setInterval(refresh, REFRESH_MS);
    setInterval(render, 30000);
  }

  start();
})();
