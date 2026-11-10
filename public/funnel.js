// Funnel panel for the watchlist: why coins dropped out, and how many were fully scored.
// app.js calls renderFunnel(status) from renderScreener(). Builds its own DOM inside #screener
// and reuses the existing dashboard CSS classes.

// Rejection categories come from recordReject() in src/index.js; expiry categories arrive as
// "expired:<stageKey>" and reuse the stage dictionary.
function funnelLabel(category) {
  if (category.startsWith("expired:")) {
    const stageKey = category.slice("expired:".length);
    const stage = t(`stage.${stageKey}`);
    return t("funnel.expired", { stage: (stage === `stage.${stageKey}` ? stageKey : stage).toLowerCase() });
  }
  const label = t(`funnel.${category}`);
  return label === `funnel.${category}` ? category : label;
}

const FUNNEL_TILES = [
  ["funnel.scored", "funnelScored"],
  ["funnel.scoreBlocked", "funnelScoreBlocked"],
  ["funnel.devUnknown", "funnelDevUnknown"],
  ["funnel.holderCheck", "funnelHolderCheck"],
];

// The four summary tiles are injected as a second stats row; the list itself lives in index.html.
function ensureFunnelTiles() {
  let row = document.querySelector("#funnelTiles");
  if (row) return row;
  const anchor = document.querySelector("#screener .screener-stats");
  if (!anchor) return null;

  row = document.createElement("div");
  row.id = "funnelTiles";
  row.className = "screener-stats funnel-tiles";
  for (const [labelKey, id] of FUNNEL_TILES) {
    const tile = document.createElement("div");
    const caption = document.createElement("span");
    caption.dataset.i18n = labelKey;
    caption.textContent = t(labelKey);
    const value = document.createElement("strong");
    value.id = id;
    value.textContent = "0";
    tile.append(caption, value);
    row.append(tile);
  }
  anchor.after(row);
  return row;
}

function renderFunnel(status = {}) {
  if (!ensureFunnelTiles()) return;
  setNumber(document.querySelector("#funnelScored"), status.scored ?? 0, fmtInt);
  setNumber(document.querySelector("#funnelScoreBlocked"), status.scoreBlocked ?? 0, fmtInt);
  setNumber(document.querySelector("#funnelDevUnknown"), status.devUnknown ?? 0, fmtInt);
  setText(document.querySelector("#funnelHolderCheck"), status.holderCheck ? t("funnel.on") : t("funnel.off"));

  const list = document.querySelector("#funnelList");
  if (!list) return;
  list.replaceChildren();
  const rows = Object.entries(status.funnel ?? {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("funnel.empty");
    list.append(empty);
    return;
  }
  const scanned = Math.max(Number(status.scanned ?? 0), 1);
  for (const [category, count] of rows) {
    const row = document.createElement("div");
    row.className = "screener-debug-row info";
    const countCell = document.createElement("span");
    countCell.className = "log-time funnel-count";
    countCell.textContent = fmtInt(count);
    const label = document.createElement("span");
    label.className = "screener-debug-message";
    label.textContent = `${funnelLabel(category)} — ${t("funnel.share", { pct: ((count / scanned) * 100).toFixed(0) })}`;
    row.append(countCell, label);
    list.append(row);
  }
}
