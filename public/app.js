// Memecoin Desk — the dashboard.
//
// One page, polled from /api/state every two seconds. The desk runs whether or not anyone is
// looking at it, so this file only ever READS state and posts the four controls (start, stop,
// close a position, save settings). It holds no model of its own.
//
// Everything here is built with DOM APIs and textContent. Coin names, log lines and API errors all
// come from places the desk does not control — a creator picks the symbol, an upstream API writes
// the error — so none of them may ever reach innerHTML. The only innerHTML in this file renders
// the constant SVG path data in ICONS below, which contains no data of any kind.
//
// Money is SOL throughout, because SOL is what the paper account actually holds. Market caps are
// USD because that is the unit both price APIs report them in.

const $ = (id) => document.getElementById(id);

/** createElement with the two things every call needs: a class and its text. */
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) if (child) node.append(child);
  return node;
}

const isNum = (n) => Number.isFinite(Number(n));
const fmt = (n, d = 2) => (isNum(n) ? Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "--");
const int = (n) => (isNum(n) ? Number(n).toLocaleString("en-US") : "--");
const sgn = (n) => (Number(n) > 0 ? "+" : "");
const cls = (n) => (Number(n) > 0 ? "up" : Number(n) < 0 ? "down" : "");
const sol = (n, d = 4) => (isNum(n) ? `${fmt(n, d)} SOL` : "--");
const solSigned = (n, d = 4) => (isNum(n) ? `${sgn(n)}${fmt(n, d)} SOL` : "--");
const pct = (n, d = 1) => (isNum(n) ? `${fmt(n, d)}%` : "--");

const hhmm = (iso) => {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("en-GB", { hour12: false }) : "--";
};

const compact = (n) => {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
};

/** $300k, $20M, $40k — compact money for the agent rail. */
function money(v) {
  const n = Number(v);
  if (!isNum(n)) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n % 1e9 ? 1 : 0)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(n % 1e3 ? 1 : 0)}k`;
  return `$${Math.round(n)}`;
}

const mins = (ms) => Math.round(Number(ms) / 60000);
const dur = (minutes) => (minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);

/* ------------------------------------------------------------ venue links
   pump.fun only has a page for tokens it minted — the rest are native
   Raydium/Orca/Meteora pairs and would 404 there. pump.fun mints carry the
   "pump" vanity suffix, so that decides the primary link; DexScreener is the
   universal fallback and the market-cap cross-check. */
const isPump = (mint) => typeof mint === "string" && mint.endsWith("pump");
const dexUrl = (mint) => `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;
const pumpUrl = (mint) => `https://pump.fun/coin/${encodeURIComponent(mint)}`;

/** A coin as a link to its venue, with an optional DexScreener cross-check chip. */
function tokenLink(symbol, mint, { chip = true } = {}) {
  const label = String(symbol || "").trim() || (mint ? `${String(mint).slice(0, 4)}…` : "?");
  if (!mint) return el("span", { text: label });

  const frag = document.createDocumentFragment();
  const pumpMint = isPump(mint);
  const link = el("a", {
    class: "tl",
    attrs: { href: pumpMint ? pumpUrl(mint) : dexUrl(mint), target: "_blank", rel: "noopener noreferrer" },
    title: `${label} on ${pumpMint ? "pump.fun" : "DexScreener"} — live market cap`,
  });
  link.append(el("span", { text: label }), el("span", { class: "ext", text: "↗" }));
  frag.append(link);

  if (chip && pumpMint) {
    frag.append(document.createTextNode(" "));
    frag.append(el("a", {
      class: "xc",
      text: "dex",
      attrs: { href: dexUrl(mint), target: "_blank", rel: "noopener noreferrer" },
      title: `${label} on DexScreener — cross-check market cap`,
    }));
  }
  return frag;
}

function replace(host, ...nodes) {
  host.replaceChildren();
  for (const node of nodes) if (node) host.append(node);
}

const emptyNote = (text) => el("div", { class: "empty", text });

let latest = null;

/* ---------------------------------------------------------------- equity
   The paper account keeps a balance and a list of closed trades, not an
   equity series, so the curve is rebuilt here: start, then one step per
   closed trade, then a final point for where the book stands right now
   (cash plus what the open positions would fetch after costs). */
function equityOf(state) {
  const account = state.account ?? {};
  const start = Number(account.startBalanceSol ?? state.settings?.paperStartBalanceSol ?? 1);
  const cash = Number(account.balanceSol ?? start);
  const open = (account.openPositions ?? []).reduce(
    (total, position) => total + (Number(position.costSol) || 0) + (Number(position.estimatedPnlSol) || 0),
    0,
  );
  return { start, cash, open, equity: cash + open };
}

/** Closed trades oldest-first. The payload sends the newest 20 first. */
const closedChronological = (state) =>
  (state.account?.closedTrades ?? []).slice().reverse().filter((trade) => isNum(trade.closedAt));

function equitySeries(state) {
  const { start, equity } = equityOf(state);
  const trades = closedChronological(state);
  const points = [];

  const firstAt = trades.length ? Number(trades[0].openedAt ?? trades[0].closedAt) : Date.now() - 3600_000;
  points.push({ t: firstAt, v: start, label: "session start" });

  let running = start;
  for (const trade of trades) {
    running += Number(trade.pnlSol) || 0;
    points.push({ t: Number(trade.closedAt), v: running, label: String(trade.symbol || trade.mint || "trade") });
  }
  points.push({ t: Date.now(), v: equity, label: "now" });
  return points;
}

/* ------------------------------------------------------------- KPI tiles */
function tile(label, value, note, tone) {
  return el("div", { class: "card" }, [
    el("div", { class: "k-label", text: label }),
    el("div", { class: `k-value ${tone || ""}`.trim(), text: value }),
    el("div", { class: "k-note", text: note }),
  ]);
}

function winRate(state) {
  const trades = closedChronological(state);
  if (!trades.length) return { rate: null, wins: 0, losses: 0, avgWin: null, avgLoss: null, capped: false };

  let wins = 0;
  let losses = 0;
  const winPcts = [];
  const lossPcts = [];
  for (const trade of trades) {
    const pnl = Number(trade.pnlSol) || 0;
    const cost = Number(trade.costSol) || 0;
    const movePct = cost > 0 ? (pnl / cost) * 100 : 0;
    if (pnl >= 0) {
      wins += 1;
      winPcts.push(movePct);
    } else {
      losses += 1;
      lossPcts.push(movePct);
    }
  }
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  return {
    rate: (wins / trades.length) * 100,
    wins,
    losses,
    avgWin: mean(winPcts),
    avgLoss: mean(lossPcts),
    capped: trades.length >= 20,
  };
}

function renderKpis(state) {
  const bots = state.screener?.bots ?? {};
  const { start, cash, equity } = equityOf(state);
  const openCount = (state.account?.openPositions ?? []).length;

  // All-time realised, summed from every closed trade the worker holds. The account's own
  // realizedPnlSol is TODAY only — it is the number the daily loss limit is measured against.
  const realised = isNum(bots.executor?.realizedPnlSol)
    ? Number(bots.executor.realizedPnlSol)
    : closedChronological(state).reduce((total, trade) => total + (Number(trade.pnlSol) || 0), 0);

  const returnPct = start > 0 ? ((equity - start) / start) * 100 : null;
  const wr = winRate(state);

  // Ring gauge: one value against a 0-100 scale, with the label always present.
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const frac = wr.rate === null ? 0 : Math.max(0, Math.min(1, wr.rate / 100));
  const ring = svg("svg", {
    class: "gauge", width: 76, height: 76, viewBox: "0 0 76 76", role: "img",
    "aria-label": `Win rate ${wr.rate === null ? "not available" : `${fmt(wr.rate, 1)} percent`}`,
  }, [
    svg("circle", { cx: 38, cy: 38, r: radius, fill: "none", stroke: "var(--surface-3)", "stroke-width": 7 }),
    svg("circle", {
      cx: 38, cy: 38, r: radius, fill: "none", stroke: "var(--series-1)", "stroke-width": 7,
      "stroke-linecap": "round", "stroke-dasharray": circumference,
      "stroke-dashoffset": circumference * (1 - frac),
      transform: "rotate(-90 38 38)", style: "transition:stroke-dashoffset .5s ease",
    }),
  ]);
  const ringText = svg("text", {
    x: 38, y: 38, "text-anchor": "middle", "dominant-baseline": "central",
    fill: "var(--text-primary)", "font-size": 15, "font-weight": 700,
  });
  ringText.textContent = wr.rate === null ? "--" : `${Math.round(wr.rate)}%`;
  ring.append(ringText);

  const gauge = el("div", { class: "card gaugecard" }, [
    ring,
    el("div", {}, [
      el("div", { class: "k-label", text: "Win rate" }),
      el("div", {
        class: "k-note",
        text: wr.rate === null ? "no closed trades" : `${wr.wins}W / ${wr.losses}L${wr.capped ? " (last 20)" : ""}`,
      }),
      el("div", {
        class: "k-note",
        text: wr.avgWin === null && wr.avgLoss === null
          ? ""
          : `avg ${wr.avgWin === null ? "--" : `${sgn(wr.avgWin)}${fmt(wr.avgWin, 1)}%`} / ${wr.avgLoss === null ? "--" : `${fmt(wr.avgLoss, 1)}%`}`,
      }),
    ]),
  ]);

  replace(
    $("kpis"),
    tile("Equity", sol(equity), `start ${fmt(start, 2)} · cash ${fmt(cash, 4)} SOL`),
    tile("Total P&L", returnPct === null ? "--" : `${sgn(returnPct)}${fmt(returnPct)}%`, `realised ${solSigned(realised)}`, cls(returnPct)),
    tile("Open", String(openCount), `${compact(bots.scout?.coins ?? 0)} coins · ${int(bots.logger?.kills ?? 0)} kills`),
    gauge,
  );
}

/* -------------------------------------------------- equity area chart */
function renderChart(state) {
  const host = $("chart");
  const points = equitySeries(state).filter((p) => isNum(p.t) && isNum(p.v));

  if (points.length < 2) {
    replace(host, el("div", { class: "chartempty", text: "waiting for the first trade" }));
    $("tip").style.opacity = 0;
    return;
  }

  const W = Math.max(host.clientWidth || 640, 320);
  const H = 268;
  const L = 68;
  const R = 16;
  const T = 16;
  const B = 26;
  const pw = W - L - R;
  const ph = H - T - B;

  const { start } = equityOf(state);
  const values = points.map((p) => p.v).concat(isNum(start) ? [start] : []);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // A flat equity curve is the truth when nothing has traded. Pad by a fixed fraction so it reads
  // as flat, rather than amplifying rounding noise into something that looks like movement.
  if (hi - lo < Math.max(hi * 0.004, 1e-6)) {
    const pad = Math.max(hi * 0.004, 1e-6);
    lo -= pad;
    hi += pad;
  } else {
    const pad = (hi - lo) * 0.14;
    lo -= pad;
    hi += pad;
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const X = (t) => L + (t1 === t0 ? pw : ((t - t0) / (t1 - t0)) * pw);
  const Y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;

  const line = points.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${X(t1).toFixed(1)},${(T + ph).toFixed(1)}L${X(t0).toFixed(1)},${(T + ph).toFixed(1)}Z`;

  const gradient = svg("linearGradient", { id: "eq", x1: 0, y1: 0, x2: 0, y2: 1 }, [
    svg("stop", { offset: "0%", "stop-color": "var(--series-1)", "stop-opacity": ".34" }),
    svg("stop", { offset: "100%", "stop-color": "var(--series-1)", "stop-opacity": "0" }),
  ]);

  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Paper equity over time" }, [
    svg("defs", {}, [gradient]),
  ]);

  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const v = lo + ((hi - lo) * i) / ticks;
    const y = Y(v);
    chart.append(svg("line", { x1: L, y1: y.toFixed(1), x2: W - R, y2: y.toFixed(1), stroke: "var(--line-soft)", "stroke-width": 1 }));
    const label = svg("text", {
      x: L - 9, y: (y + 3.5).toFixed(1), "text-anchor": "end", fill: "var(--muted)",
      "font-size": 10, "font-family": "ui-monospace,monospace",
    });
    label.textContent = v.toFixed(3);
    chart.append(label);
  }

  // First, middle and last — but the points are spaced by WHEN they happened, not evenly, so a
  // burst of trades inside one minute puts the middle label on top of the first one. Drop it
  // unless it has room on both sides.
  const lastIndex = points.length - 1;
  const middleIndex = Math.floor(points.length / 2);
  const roomFor = (i) => Math.abs(X(points[i].t) - X(points[0].t)) > 72 && Math.abs(X(points[lastIndex].t) - X(points[i].t)) > 72;
  const labelled = [0, ...(roomFor(middleIndex) ? [middleIndex] : []), lastIndex];

  for (const i of labelled) {
    const p = points[i];
    const label = svg("text", {
      x: X(p.t).toFixed(1), y: H - 7,
      "text-anchor": i === 0 ? "start" : i === lastIndex ? "end" : "middle",
      fill: "var(--muted)", "font-size": 10, "font-family": "ui-monospace,monospace",
    });
    label.textContent = hhmm(p.t);
    chart.append(label);
  }

  chart.append(svg("path", { d: area, fill: "url(#eq)" }));
  chart.append(svg("path", { d: line, fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  const crossLine = svg("line", { y1: T, y2: T + ph, stroke: "var(--series-1)", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: ".6" });
  const crossDot = svg("circle", { r: 4.5, fill: "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2 });
  const cross = svg("g", { style: "opacity:0" }, [crossLine, crossDot]);
  chart.append(cross);

  const last = points[points.length - 1];
  const lx = X(last.t);
  const ly = Y(last.v);
  chart.append(svg("circle", { cx: lx.toFixed(1), cy: ly.toFixed(1), r: 4.5, fill: "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2 }));

  const labelW = 92;
  const flip = lx + labelW + 8 > W - R;
  const badgeText = svg("text", {
    x: labelW / 2, y: 4, "text-anchor": "middle", fill: "var(--text-primary)",
    "font-size": 11.5, "font-weight": 700, "font-family": "ui-monospace,monospace",
  });
  badgeText.textContent = fmt(last.v, 4);
  chart.append(svg("g", {
    transform: `translate(${(flip ? lx - labelW - 9 : lx + 9).toFixed(1)}, ${Math.max(T + 9, Math.min(ly, T + ph - 9)).toFixed(1)})`,
  }, [
    svg("rect", { x: 0, y: -11, width: labelW, height: 22, rx: 6, fill: "var(--surface-3)", stroke: "var(--line)" }),
    badgeText,
  ]));

  const hit = svg("rect", { x: L, y: T, width: pw, height: ph, fill: "transparent", style: "cursor:crosshair" });
  chart.append(hit);
  replace(host, chart);

  // Hover layer: nearest point, crosshair and tooltip.
  const tip = $("tip");
  hit.addEventListener("mousemove", (event) => {
    const box = chart.getBoundingClientRect();
    const sx = (event.clientX - box.left) * (W / box.width);
    let best = 0;
    let bestDistance = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(X(p.t) - sx);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    const p = points[best];
    const px = X(p.t);
    const py = Y(p.v);
    cross.style.opacity = 1;
    crossLine.setAttribute("x1", px);
    crossLine.setAttribute("x2", px);
    crossDot.setAttribute("cx", px);
    crossDot.setAttribute("cy", py);

    const delta = isNum(start) && start > 0 ? ((p.v - start) / start) * 100 : null;
    const value = el("span", { class: "tv", text: `${fmt(p.v, 4)} SOL` });
    const change = delta === null ? null : el("span", { class: cls(delta), text: ` ${sgn(delta)}${fmt(delta)}%` });
    const when = el("span", { class: "tt", text: `${hhmm(p.t)} · ${p.label}` });
    replace(tip, value, change, el("br"), when);
    tip.style.opacity = 1;

    const rel = px * (box.width / W);
    tip.style.left = `${Math.min(Math.max(rel - tip.offsetWidth / 2, 2), box.width - tip.offsetWidth - 2)}px`;
    tip.style.top = `${Math.max(py * (box.height / H) - tip.offsetHeight - 12, 2)}px`;
  });
  hit.addEventListener("mouseleave", () => {
    cross.style.opacity = 0;
    tip.style.opacity = 0;
  });
}

/* ----------------------------------------------------------- agent rail */
// Constant SVG path data. Nothing here is interpolated, which is why these may be assigned with
// innerHTML; no value from the desk, an API or a coin creator is ever put through this path.
const ICONS = {
  scout: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  filter: '<path d="M3 4h18l-7 8v7l-4 2v-9z"/>',
  analyst: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  executor: '<path d="M4 12h12M12 6l6 6-6 6"/>',
  risk: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/>',
  logger: '<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>',
};
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.24.58.78.98 1.4 1.01H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';

const AGENT_COLOR = {
  scout: "var(--agent-scout)", filter: "var(--agent-filter)", analyst: "var(--agent-analyst)",
  executor: "var(--agent-executor)", risk: "var(--agent-risk)", logger: "var(--agent-logger)",
};

/** The newest plain-language event at one of these levels, or null. */
function lastEvent(state, levels) {
  for (const entry of state.screenerDebug ?? []) {
    if (levels.includes(entry.level)) return entry;
  }
  return null;
}

/** An agent's activity line: the coin it last acted on, then what happened. */
function activityLine(state, event, idleText) {
  if (!event) return el("span", { class: "idle", text: idleText });
  const frag = document.createDocumentFragment();
  if (event.mint) {
    frag.append(tokenLink(symbolFor(state, event.mint), event.mint, { chip: false }));
    frag.append(document.createTextNode(" "));
  }
  frag.append(el("span", { text: event.message ?? "" }));
  return frag;
}

/** Best-effort mint -> symbol, from wherever the payload happens to name it. */
function symbolFor(state, mint) {
  const bots = state.screener?.bots ?? {};
  const pools = [
    state.account?.openPositions ?? [],
    bots.analyst?.candidates ?? [],
    bots.executor?.watching ?? [],
    bots.scout?.recent ?? [],
    state.account?.closedTrades ?? [],
  ];
  for (const pool of pools) {
    const hit = pool.find((item) => item.mint === mint && item.symbol);
    if (hit) return hit.symbol;
  }
  return "";
}

function agentRow({ key, name, rule, activity, metric, tone }) {
  const icon = el("button", {
    class: "agico",
    title: `${name} settings`,
    attrs: { type: "button", "data-agent": key, style: `background:${AGENT_COLOR[key]}`, "aria-label": `${name} settings` },
  });
  const glyph = svg("svg", { class: "ico", viewBox: "0 0 24 24", "stroke-linecap": "round", "stroke-linejoin": "round" });
  glyph.innerHTML = ICONS[key];
  const gearWrap = el("span", { class: "gear" });
  const gear = svg("svg", { viewBox: "0 0 24 24", "stroke-linecap": "round" });
  gear.innerHTML = GEAR;
  gearWrap.append(gear);
  icon.append(glyph, gearWrap);

  const identity = el("div", {}, [
    el("div", { class: "agname", text: name }),
    el("div", { class: "agrule", text: rule }),
  ]);
  const act = el("div", { class: "agact" });
  act.append(activity);

  return el("div", { class: "ag" }, [icon, identity, act, el("div", { class: `agmetric ${tone}`, text: metric })]);
}

function renderAgents(state) {
  const bots = state.screener?.bots;
  if (!bots) {
    replace($("agents"), emptyNote("the desk is not running"));
    $("deskScanned").textContent = "0";
    $("deskTraded").textContent = "0";
    return;
  }

  const { scout = {}, filter = {}, analyst = {}, executor = {}, risk = {}, logger = {} } = bots;
  const settings = state.settings ?? {};
  const window = scout.window ?? {};
  const limits = filter.limits ?? {};

  const scoutSighting = (scout.recent ?? [])[0];
  const scoutEvent = scoutSighting
    ? { mint: scoutSighting.mint, message: `seen via ${scoutSighting.source ?? "feed"}` }
    : lastEvent(state, ["candidate"]);

  const reasons = Object.keys(logger.byCategory ?? {}).length;
  const topCandidate = (analyst.candidates ?? [])[0];

  const rows = [
    {
      key: "scout", name: "Scout",
      rule: `age ${dur(Math.round((window.minAgeSeconds ?? 0) / 60))}–${Math.round((window.maxAgeSeconds ?? 0) / 3600)}h · ${money(window.minMarketCapUsd)}–${money(window.maxMarketCapUsd)}`,
      activity: activityLine(state, scoutEvent, "nothing seen yet"),
      metric: `${compact(scout.coins ?? 0)} coins`,
      tone: scout.inWindow > 0 ? "on" : "off",
    },
    {
      key: "filter", name: "Filter",
      rule: `liq ≥${money(limits.minLiquidityUsd)} · LP ≥${limits.minLpLockedPct ?? "?"}% · dev ≤${limits.maxDevPct ?? "?"}% · 1h <${limits.maxPriceChangeH1 ?? "?"}%`,
      activity: activityLine(state, lastEvent(state, ["filtered"]), "nothing to judge yet"),
      metric: `${int(filter.killed ?? 0)} killed`,
      tone: filter.killed > 0 ? "no" : "off",
    },
    {
      key: "analyst", name: "Analyst",
      rule: `scores survivors · ${analyst.passScore ?? "?"}+ passes`,
      activity: topCandidate
        ? activityLine(state, { mint: topCandidate.mint, message: `scores ${fmt(topCandidate.score, 1)}` }, "")
        : activityLine(state, null, "nothing cleared the filter"),
      metric: `${int(analyst.scored ?? 0)} scored`,
      tone: analyst.passingNow > 0 ? "on" : analyst.scored > 0 ? "no" : "off",
    },
    {
      key: "executor", name: "Executor",
      rule: `${fmt((settings.positionPct ?? 0) * 100, 0)}% of equity · ${settings.maxOpenPositions ?? "?"} slots`,
      activity: activityLine(state, lastEvent(state, ["entry", "exit"]), executor.watchingCount ? `watching ${executor.watchingCount}` : "nothing passed yet"),
      metric: `≤ ${fmt((settings.positionPct ?? 0) * 100, 0)}%`,
      tone: executor.entries > 0 ? "on" : "off",
    },
    {
      key: "risk", name: "Risk",
      rule: `−${fmt((risk.stopPct ?? 0) * 100, 0)}% stop · trail ${fmt((risk.trailPct ?? 0) * 100, 0)}% at +${fmt((risk.trailAfterPct ?? 0) * 100, 0)}%`,
      activity: risk.blockedReason
        ? el("span", { text: risk.blockedReason })
        : activityLine(state, lastEvent(state, ["blocked"]), executor.openPositions ? `${executor.openPositions} open` : "no open risk"),
      metric: executor.openPositions > 0 ? `${executor.openPositions} open` : risk.blockedReason ? "halted" : `halt ${sol(risk.maxDailyLossSol ?? 0, 2)}`,
      tone: executor.openPositions > 0 ? "on" : risk.blockedReason ? "no" : "off",
    },
    {
      key: "logger", name: "Logger",
      rule: "a reason for every kill",
      activity: activityLine(state, lastEvent(state, ["filtered", "blocked", "info"]), "nothing logged yet"),
      metric: `${reasons} reason${reasons === 1 ? "" : "s"}`,
      tone: logger.kills > 0 ? "on" : "off",
    },
  ];

  replace($("agents"), ...rows.map(agentRow));
  $("deskScanned").textContent = compact(scout.coins ?? 0);
  $("deskTraded").textContent = int(executor.entries ?? 0);

  // Settings saved while the desk was down cannot reach a worker that is not there.
  const pending = Boolean(pendingRestart) && state.runtime?.status !== "running";
  $("deskPending").hidden = !pending;
  $("deskPending").textContent = pending ? "settings saved — they apply on the next Start" : "";
}

/* --------------------------------------------------------------- funnel */
function renderFunnel(state) {
  const bots = state.screener?.bots;
  if (!bots) {
    replace($("funnel"), emptyNote("no session yet"));
    return;
  }
  const { scout = {}, filter = {}, analyst = {}, executor = {} } = bots;

  // Every step is a RUNNING TOTAL, so each percentage is a real share of the step above it. The
  // watchlist is the one number the executor keeps as a live count, so the total that ever reached
  // it is rebuilt here: the ones it bought, the ones it gave up on, and the ones still on it.
  const watched = (executor.entries ?? 0) + (executor.dropped ?? 0) + (executor.watchingCount ?? 0);

  const steps = [
    ["discovered", scout.coins ?? 0],
    ["in window", scout.inWindow ?? 0],
    ["cleared", filter.passed ?? 0],
    ["scored", analyst.scored ?? 0],
    [`passed ${analyst.passScore ?? 70}+`, analyst.passed ?? 0],
    ["watched", watched],
    ["fills", executor.entries ?? 0],
  ];
  const max = Math.max(...steps.map(([, v]) => v), 1);

  const nodes = steps.map(([name, value], i) => {
    const previous = i === 0 ? null : steps[i - 1][1];
    const share = previous === null ? null : previous === 0 ? 0 : (value / previous) * 100;
    const bar = el("div", { class: "fbar" });
    bar.style.width = `${Math.max((value / max) * 100, value > 0 ? 1.5 : 0)}%`;
    const count = el("div", { class: "fcount", text: int(value) });
    if (share !== null) {
      count.append(document.createTextNode(" "));
      count.append(el("span", { class: "fpct", text: `${share.toFixed(0)}%` }));
    }
    return el("div", { class: "fstep" }, [
      el("div", { class: "fname", text: name }),
      el("div", { class: "ftrack" }, [bar]),
      count,
    ]);
  });

  nodes.push(el("div", {
    class: "bd",
    text: `${int(scout.universeSize ?? 0)} coins held in the registry · ${int(executor.watchingCount ?? 0)} on the watchlist right now · ${int(filter.waiting ?? 0)} waiting on a safety check`,
  }));
  nodes[nodes.length - 1].style.marginTop = "9px";
  replace($("funnel"), ...nodes);
}

function renderKills(state) {
  const byCategory = state.screener?.bots?.logger?.byCategory ?? {};
  const rows = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    replace($("kills"), emptyNote("no kills recorded yet"));
    return;
  }
  const max = rows[0][1];
  replace($("kills"), ...rows.slice(0, 13).map(([reason, count]) => {
    const fill = el("div", { class: "kbf" });
    fill.style.width = `${(count / max) * 100}%`;
    return el("div", { class: "kill" }, [
      el("div", { class: "kb" }, [fill, el("div", { class: "kbl", text: reason })]),
      el("div", { class: "kn", text: int(count) }),
    ]);
  }));
}

/* ------------------------------------------------------- closed trades */
function renderClosed(state) {
  const trades = state.account?.closedTrades ?? [];
  if (!trades.length) {
    replace($("closed"), emptyNote("no closed trades yet"));
    return;
  }
  const head = el("tr", {}, [
    el("th", { text: "Coin" }),
    el("th", { text: "Exit" }),
    el("th", { class: "num", text: "P&L" }),
    el("th", { class: "num", text: "Held" }),
    el("th", { class: "num", text: "Score" }),
  ]);
  const body = el("tbody");
  for (const trade of trades) {
    const cost = Number(trade.costSol) || 0;
    const pnl = Number(trade.pnlSol) || 0;
    const movePct = cost > 0 ? (pnl / cost) * 100 : null;
    const held = isNum(trade.openedAt) && isNum(trade.closedAt) ? mins(trade.closedAt - trade.openedAt) : null;

    const coin = el("td", { class: "sym" });
    coin.append(tokenLink(trade.symbol, trade.mint, { chip: false }));
    body.append(el("tr", {}, [
      coin,
      el("td", { text: trade.reason ?? "" }),
      el("td", { class: `num ${cls(pnl)}`, text: movePct === null ? solSigned(pnl) : `${sgn(movePct)}${fmt(movePct)}%` }),
      el("td", { class: "num", text: held === null ? "--" : `${held}m` }),
      el("td", { class: "num", text: isNum(trade.entryScore) ? fmt(trade.entryScore, 0) : "--" }),
    ]));
  }
  replace($("closed"), el("table", {}, [el("thead", {}, [head]), body]));
}

/* ------------------------------------------- scored but did not trade */
function renderNear(state) {
  const candidates = state.screener?.bots?.analyst?.candidates ?? [];
  if (!candidates.length) {
    replace($("near"), emptyNote("nothing has reached the analyst yet"));
    return;
  }
  replace($("near"), ...candidates.slice(0, 12).map((candidate) => {
    const line = el("div", {});
    line.append(el("span", { class: `sc ${candidate.score >= 70 ? "up" : ""}`.trim(), text: fmt(candidate.score, 1) }));
    const name = el("b");
    name.append(tokenLink(candidate.symbol, candidate.mint));
    line.append(name, document.createTextNode(" "));

    const detail = [
      isNum(candidate.marketCapUsd) ? money(candidate.marketCapUsd) : null,
      isNum(candidate.liquidityUsd) ? `liq ${money(candidate.liquidityUsd)}` : null,
      isNum(candidate.buyersH1) ? `${candidate.buyersH1} buyers/h` : null,
      isNum(candidate.ageSeconds) ? `${dur(Math.round(candidate.ageSeconds / 60))} old` : null,
      // How much of the score was actually measured rather than defaulted. A coin scoring well on
      // two known parts and four shrugs is not the same bet as one measured all the way through.
      isNum(candidate.measured) ? `measured ${candidate.measured}/6` : null,
      candidate.lead ? `led by ${candidate.lead}` : null,
    ].filter(Boolean).join(" · ");
    line.append(el("span", { class: "bd", text: detail }));

    const row = el("div", { class: "miss" }, [line]);

    // The six score parts, each a 0-1 fraction of its own weight. An unmeasured part is stored as
    // a neutral 0.5 rather than a zero, so 0.50 here reads as "not known", not "bad".
    const parts = candidate.parts && typeof candidate.parts === "object" ? Object.entries(candidate.parts) : [];
    if (parts.length) {
      const text = parts
        .map(([part, value]) => `${part} ${isNum(value) ? fmt(value, 2) : "n/a"}`)
        .join(" · ");
      const details = el("details", {}, [el("summary", { text: "components" })]);
      const bd = el("div", { class: "bd", text });
      bd.style.paddingTop = "5px";
      details.append(bd);
      row.append(details);
    }
    return row;
  }));
}

/* ---------------------------------------------------------- activity log */
// The worker tags each event; anything unexpected falls back to a neutral chip.
const KNOWN_LEVELS = new Set(["candidate", "entry", "exit", "blocked", "filtered", "info", "warning", "error"]);
const LEVEL_TAG = {
  candidate: "look", entry: "entry", exit: "exit", blocked: "halt",
  filtered: "kill", info: "info", warning: "warn", error: "error",
};
const LEVEL_CLASS = {
  filtered: "kill", candidate: "candidate", entry: "entry", exit: "exit",
  blocked: "blocked", info: "info", warning: "blocked", error: "error",
};

function renderFeed(state) {
  const events = state.screenerDebug ?? [];
  if (!events.length) {
    replace($("feed"), emptyNote("no events yet"));
    return;
  }
  replace($("feed"), ...events.map((event) => {
    const level = KNOWN_LEVELS.has(event.level) ? event.level : "info";
    const message = el("div", { class: "msg" });
    if (event.mint) {
      const name = el("b");
      name.append(tokenLink(symbolFor(state, event.mint), event.mint, { chip: false }));
      message.append(name, document.createTextNode(" "));
    }
    message.append(el("span", { text: event.message ?? "" }));
    return el("div", { class: "ev" }, [
      el("div", { class: "t", text: hhmm(event.timestamp) }),
      el("div", { class: `tag ${LEVEL_CLASS[level]}`, text: LEVEL_TAG[level] }),
      message,
    ]);
  }));
}

/* ------------------------------------------------------------- controls */
let busy = false;

/**
 * The buttons follow the WORKER, not the freshness of the log: a desk that is alive but between
 * ticks would otherwise read as stopped and offer to start a second one.
 */
function renderControls(state) {
  if (busy) return;
  const run = $("btnRun");
  const stop = $("btnStop");
  const running = state.runtime?.status === "running";

  run.textContent = running ? "Restart" : "Start";
  run.className = `btn ${running ? "warn" : "go"}`;
  run.dataset.action = running ? "restart" : "start";
  run.title = running ? "Stop the desk and start it again — the paper book is kept" : "Start the desk";
  stop.disabled = !running;
  stop.title = running ? "Stop the desk; open positions stay open and unmanaged" : "The desk is not running";
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function control(action, button) {
  if (busy) return;
  if (action === "stop" && !confirm("Stop the desk? Open positions stay open and unmanaged until it runs again.")) return;

  busy = true;
  const label = button.textContent;
  button.textContent = action === "stop" ? "Stopping…" : action === "restart" ? "Restarting…" : "Starting…";
  $("btnRun").classList.add("busy");
  $("btnStop").classList.add("busy");
  try {
    if (action === "stop" || action === "restart") await postJson("/api/stop");
    if (action === "start" || action === "restart") await postJson("/api/start", { settings: latest?.settings });
    $("error").textContent = "";
  } catch (error) {
    $("error").textContent = `control: ${error.message}`;
    button.textContent = label;
  } finally {
    $("btnRun").classList.remove("busy");
    $("btnStop").classList.remove("busy");
    busy = false;
    await tick();
  }
}

$("btnRun").addEventListener("click", (event) => control(event.currentTarget.dataset.action || "start", event.currentTarget));
$("btnStop").addEventListener("click", (event) => control("stop", event.currentTarget));

/* ------------------------------------------------------- settings modal */
let SCHEMA = null;
let VALUES = null;
let openAgent = null;
let pendingRestart = false;

const fieldId = (name) => `f_${name}`;

async function loadSettings() {
  const response = await fetch("/api/settings", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  SCHEMA = body.schema;
  VALUES = body.values;
  return body;
}

/** The edited value of one field, straight from its input. */
function readField(field) {
  const input = $(fieldId(field.name));
  if (!input) return VALUES[field.name];
  if (field.type === "bool") return input.checked;
  if (field.type === "enum") return input.value;
  return Number(input.value);
}

function markChanged() {
  const group = SCHEMA?.[openAgent];
  if (!group) return;
  for (const field of group.fields) {
    const input = $(fieldId(field.name));
    if (!input) continue;
    const changed = String(readField(field)) !== String(VALUES[field.name]);
    input.closest(".fld").classList.toggle("changed", changed);
  }
}

function buildField(field) {
  const label = el("div", { class: "fldLabel", text: field.label });
  const inputWrap = el("div", { class: "fldIn" });

  if (field.type === "bool") {
    const toggle = el("label", { class: "sw" });
    const input = el("input", { attrs: { type: "checkbox", id: fieldId(field.name) } });
    input.checked = Boolean(VALUES[field.name]);
    input.addEventListener("change", markChanged);
    toggle.append(input, el("span", {}));
    inputWrap.append(toggle);
  } else if (field.type === "enum") {
    const select = el("select", { attrs: { id: fieldId(field.name) } });
    for (const option of field.options ?? []) {
      const node = el("option", { text: option, attrs: { value: option } });
      if (option === VALUES[field.name]) node.selected = true;
      select.append(node);
    }
    select.addEventListener("change", markChanged);
    inputWrap.append(select);
  } else {
    const input = el("input", {
      attrs: {
        type: "number", id: fieldId(field.name),
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
        step: field.step ?? "any",
      },
    });
    input.value = String(VALUES[field.name]);
    input.addEventListener("input", markChanged);
    inputWrap.append(input);
    if (field.unit) inputWrap.append(el("span", { class: "u", text: field.unit }));
  }

  return el("div", { class: "fld" }, [
    el("div", { class: "fldTop" }, [label, inputWrap]),
    field.help ? el("div", { class: "fldHelp", text: field.help }) : null,
  ]);
}

async function openSettings(agent) {
  openAgent = agent;
  $("mMsg").className = "sheetMsg";
  $("mMsg").textContent = "";
  $("mSave").disabled = false;
  replace($("mBody"), emptyNote("loading…"));
  $("modal").hidden = false;

  try {
    if (!SCHEMA) await loadSettings();
    const group = SCHEMA[agent];
    if (!group) throw new Error("this agent has no settings");
    $("mTitle").textContent = `${group.title} settings`;
    $("mBlurb").textContent = group.blurb ?? "";
    replace($("mBody"), ...group.fields.map(buildField));
    $("mClose").focus();
  } catch (error) {
    replace($("mBody"), emptyNote(error.message));
  }
}

function closeSettings() {
  $("modal").hidden = true;
  openAgent = null;
}

async function saveSettings() {
  const group = SCHEMA?.[openAgent];
  if (!group) return;

  const changes = {};
  for (const field of group.fields) {
    const value = readField(field);
    if (String(value) !== String(VALUES[field.name])) changes[field.name] = value;
  }
  if (!Object.keys(changes).length) {
    $("mMsg").className = "sheetMsg";
    $("mMsg").textContent = "nothing changed";
    return;
  }

  $("mSave").disabled = true;
  $("mMsg").className = "sheetMsg";
  $("mMsg").textContent = "saving…";
  try {
    const result = await postJson("/api/settings", { settings: changes });
    VALUES = result.values ?? { ...VALUES, ...changes };
    pendingRestart = Boolean(result.pendingRestart);
    $("mMsg").className = "sheetMsg good";
    $("mMsg").textContent = result.applied
      ? `Saved ${result.changed} setting(s); the desk picked them up.`
      : `Saved ${result.changed} setting(s). They apply on the next Start.`;
    markChanged();
    await tick();
  } catch (error) {
    $("mMsg").className = "sheetMsg bad";
    $("mMsg").textContent = error.message;
  } finally {
    $("mSave").disabled = false;
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".agico[data-agent]");
  if (button) openSettings(button.dataset.agent);
});
$("mClose").addEventListener("click", closeSettings);
$("mCancel").addEventListener("click", closeSettings);
$("mSave").addEventListener("click", saveSettings);
$("modal").addEventListener("click", (event) => {
  if (event.target.id === "modal") closeSettings();
});
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("modal").hidden) closeSettings();
});

/* ------------------------------------------------------------------ tick */
async function tick() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = await response.json();
    latest = state;
    $("error").textContent = "";

    const running = state.runtime?.status === "running";
    const connected = Boolean(state.runtime?.feedConnected);
    $("status").className = `badge ${running ? (connected ? "live" : "warn") : ""}`.trim();
    $("statusText").textContent = running ? (connected ? "live" : "starting") : "stopped";

    const updated = state.screener?.updatedAt;
    const age = updated ? Math.round((Date.now() - Date.parse(updated)) / 1000) : null;
    $("meta").textContent = [
      state.runtime?.mode ? `${state.runtime.mode} mode` : "",
      age === null ? "" : `${age}s ago`,
    ].filter(Boolean).join(" · ");

    renderControls(state);
    renderKpis(state);
    renderChart(state);
    renderAgents(state);
    renderFunnel(state);
    renderKills(state);
    renderClosed(state);
    renderNear(state);
    renderFeed(state);

    $("footer").textContent = `updated ${hhmm(Date.now())} · ${(state.screenerDebug ?? []).length} event(s) in the log · paper mode · refreshes every 2s`;
  } catch (error) {
    $("error").textContent = `dashboard: ${error.message}`;
  }
}

tick();
setInterval(tick, 2000);
addEventListener("resize", () => {
  if (latest) renderChart(latest);
});
