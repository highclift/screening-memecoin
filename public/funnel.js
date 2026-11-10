// Why bot 2 turned coins down, and how much of its work the numbers account for.
// app.js calls renderFunnel(status) from renderScreener(). Builds its own DOM inside #screener and
// reuses the existing dashboard CSS classes.

const FUNNEL_TILES = [
  ["funnel.judged", "funnelJudged"],
  ["funnel.watching", "funnelWatching"],
  ["funnel.rugs", "funnelRugs"],
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
  const filter = status.bots?.filter ?? {};
  setNumber(document.querySelector("#funnelJudged"), filter.evaluated ?? 0, fmtInt);
  setNumber(document.querySelector("#funnelWatching"), filter.watch ?? 0, fmtInt);
  setNumber(document.querySelector("#funnelRugs"), filter.rugs ?? 0, fmtInt);
  setText(document.querySelector("#funnelHolderCheck"), filter.holderCheck ? t("funnel.on") : t("funnel.off"));

  const list = document.querySelector("#funnelList");
  if (!list) return;
  list.replaceChildren();
  const rows = Object.entries(filter.categories ?? {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("funnel.empty");
    list.append(empty);
    return;
  }
  const judged = Math.max(Number(filter.evaluated ?? 0), 1);
  for (const [category, count] of rows) {
    const row = document.createElement("div");
    row.className = "screener-debug-row info";
    const countCell = document.createElement("span");
    countCell.className = "log-time funnel-count";
    countCell.textContent = fmtInt(count);
    const label = document.createElement("span");
    label.className = "screener-debug-message";
    label.textContent = `${categoryLabel(category)} — ${t("funnel.share", { pct: ((count / judged) * 100).toFixed(0) })}`;
    row.append(countCell, label);
    list.append(row);
  }
}
