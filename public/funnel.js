// Funnel panel for the screener: shows why tokens dropped out and how many reached the analyst.
// Loaded before app.js; app.js calls renderFunnel(status) from renderScreener().
// It builds its own DOM inside #screener and reuses the existing dashboard CSS classes.

const FUNNEL_LABELS = {
  market_cap: "Market cap di luar range",
  capacity: "Kapasitas screening penuh",
  dev_history: "Riwayat dev buruk",
  social: "Tautan sosial tidak memenuhi syarat",
  liquidity: "Likuiditas terlalu kecil",
  holders: "Holder terlalu terkonsentrasi",
};

const EXPIRY_LABELS = {
  blocked: "Habis waktu: terhalang batas risiko",
  social: "Habis waktu: menunggu data sosial",
  trades: "Habis waktu: trade kurang",
  buys: "Habis waktu: buy kurang",
  buyers: "Habis waktu: pembeli unik kurang",
  pullback: "Habis waktu: belum ada pullback",
  rebound: "Habis waktu: belum ada pantulan",
  holders: "Habis waktu: menunggu data holder",
  score: "Habis waktu: skor di bawah batas",
  signal: "Habis waktu: sinyal tidak sempat dieksekusi",
};

function funnelLabel(category) {
  if (category.startsWith("expired:")) {
    const stage = category.slice("expired:".length);
    return EXPIRY_LABELS[stage] ?? `Habis waktu: ${stage}`;
  }
  return FUNNEL_LABELS[category] ?? category;
}

function ensureFunnelPanel() {
  let panel = document.querySelector("#funnelPanel");
  if (panel) return panel;
  const anchor = document.querySelector("#screener .screener-stats");
  if (!anchor) return null;

  panel = document.createElement("div");
  panel.id = "funnelPanel";

  const stats = document.createElement("div");
  stats.className = "screener-stats";
  for (const [label, id] of [
    ["Dinilai analyst", "funnelScored"],
    ["Ditahan skor", "funnelScoreBlocked"],
    ["Dev tanpa data", "funnelDevUnknown"],
    ["Cek holder (RPC)", "funnelHolderCheck"],
  ]) {
    const tile = document.createElement("div");
    const caption = document.createElement("span");
    caption.textContent = label;
    const value = document.createElement("strong");
    value.id = id;
    value.textContent = "0";
    tile.append(caption, value);
    stats.append(tile);
  }

  const heading = document.createElement("div");
  heading.className = "screener-subheading";
  const title = document.createElement("strong");
  title.textContent = "Mengapa token gugur";
  const note = document.createElement("span");
  note.textContent = "sejak scanner dimulai";
  heading.append(title, note);

  const list = document.createElement("div");
  list.className = "screener-debug-list";
  list.id = "funnelList";

  panel.append(stats, heading, list);
  anchor.after(panel);
  return panel;
}

function renderFunnel(status = {}) {
  if (!ensureFunnelPanel()) return;
  document.querySelector("#funnelScored").textContent = String(status.scored ?? 0);
  document.querySelector("#funnelScoreBlocked").textContent = String(status.scoreBlocked ?? 0);
  document.querySelector("#funnelDevUnknown").textContent = String(status.devUnknown ?? 0);
  document.querySelector("#funnelHolderCheck").textContent = status.holderCheck ? "Aktif" : "Mati";

  const list = document.querySelector("#funnelList");
  list.replaceChildren();
  const rows = Object.entries(status.funnel ?? {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Belum ada token yang gugur.";
    list.append(empty);
    return;
  }
  const scanned = Math.max(Number(status.scanned ?? 0), 1);
  for (const [category, count] of rows) {
    const row = document.createElement("div");
    row.className = "screener-debug-row info";
    const countCell = document.createElement("span");
    countCell.className = "log-time";
    countCell.textContent = String(count);
    const label = document.createElement("span");
    label.className = "screener-debug-message";
    label.textContent = `${funnelLabel(category)} (${((count / scanned) * 100).toFixed(0)}% dari yang ditemukan)`;
    row.append(countCell, label);
    list.append(row);
  }
}
