/* =========================================================================
   Market Pulse — 5paisa Live Dashboard
   -------------------------------------------------------------------------
   This file talks ONLY to your own backend proxy (see /server), never
   directly to 5paisa, because 5paisa login needs secret keys that must
   never sit in browser JS / a public GitHub Pages repo.

   Set API_BASE below to your deployed proxy URL, e.g.
   "https://your-proxy.onrender.com"
   ========================================================================= */

const CONFIG = {
  API_BASE: window.MARKET_PULSE_API_BASE || "http://localhost:8787",
  QUOTE_POLL_MS: 3000,       // LTP / volume / bid-ask — fast poll
  CANDLE_POLL_MS: 15000,     // candles for VWAP / MA / Heikin-Ashi
  OPTIONCHAIN_POLL_MS: 20000 // OI / PCR — slower, heavier endpoint
};

const els = {
  symbolInput: document.getElementById("symbolInput"),
  exchSelect: document.getElementById("exchSelect"),
  loadBtn: document.getElementById("loadBtn"),
  connDot: document.getElementById("connDot"),
  connText: document.getElementById("connText"),
  heroSymbol: document.getElementById("heroSymbol"),
  heroLtp: document.getElementById("heroLtp"),
  heroChange: document.getElementById("heroChange"),
  heroTime: document.getElementById("heroTime"),
  heroExch: document.getElementById("heroExch"),
  grid: document.getElementById("metricsGrid"),
  maCrossValue: document.getElementById("maCrossValue"),
  oiCrossValue: document.getElementById("oiCrossValue"),
  haWick: document.getElementById("haWick"),
  haBody: document.getElementById("haBody"),
  footNote: document.getElementById("footNote"),
};

const CARD_DEFS = [
  { key: "volume", label: "Volume" },
  { key: "bidAsk", label: "Bid / Ask" },
  { key: "vwap", label: "VWAP" },
  { key: "oi", label: "Open Interest" },
  { key: "oiChangePct", label: "OI Change %" },
  { key: "pcr", label: "PCR" },
  { key: "ma7", label: "7 MA (price)" },
  { key: "ma20", label: "20 MA (price)" },
  { key: "prevClose", label: "Previous Close" },
  { key: "open", label: "Open" },
];

let state = {
  symbol: null,
  exch: "N",
  exchType: "C",
  timers: [],
  oiHistoryKey: null,
};

function buildCards() {
  els.grid.innerHTML = "";
  CARD_DEFS.forEach((def) => {
    const card = document.createElement("div");
    card.className = "card";
    card.id = `card-${def.key}`;
    card.innerHTML = `<div class="label">${def.label}</div><div class="value" id="val-${def.key}">—</div><div class="sub" id="sub-${def.key}"></div>`;
    els.grid.appendChild(card);
  });
}

function setVal(key, text, cls) {
  const el = document.getElementById(`val-${key}`);
  if (!el) return;
  el.textContent = text;
  el.className = "value" + (cls ? " " + cls : "");
}
function setSub(key, text) {
  const el = document.getElementById(`sub-${key}`);
  if (el) el.textContent = text;
}

function setConn(status) {
  els.connDot.className = "dot" + (status === "live" ? " live" : status === "down" ? " down" : "");
  els.connText.textContent =
    status === "live" ? "live" : status === "down" ? "disconnected" : "connecting…";
}

async function api(path) {
  const res = await fetch(`${CONFIG.API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/* ---------------- indicator math ---------------- */

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function detectCrossover(prevFast, prevSlow, fast, slow) {
  if ([prevFast, prevSlow, fast, slow].some((v) => v === null || v === undefined)) return null;
  if (prevFast <= prevSlow && fast > slow) return "bull"; // golden cross
  if (prevFast >= prevSlow && fast < slow) return "bear"; // death cross
  return fast > slow ? "above" : "below";
}

function computeHeikinAshi(candles) {
  // candles: [{open,high,low,close}] oldest -> newest
  let haPrev = null;
  let last = null;
  for (const c of candles) {
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = haPrev ? (haPrev.haOpen + haPrev.haClose) / 2 : (c.open + c.close) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    haPrev = { haOpen, haClose, haHigh, haLow };
    last = haPrev;
  }
  return last;
}

function vwapFromCandles(candles) {
  let cumPV = 0;
  let cumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * (c.volume || 0);
    cumV += c.volume || 0;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

/* ---------------- OI history (client-persisted, per symbol) ---------------- */

function loadOiHistory(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function pushOiHistory(key, oiValue) {
  const arr = loadOiHistory(key);
  const today = new Date().toISOString().slice(0, 10);
  arr.push({ t: Date.now(), day: today, oi: oiValue });
  // keep last 200 points, and only same-day + previous day for a lightweight file
  const trimmed = arr.slice(-200);
  localStorage.setItem(key, JSON.stringify(trimmed));
  return trimmed;
}

/* ---------------- render ---------------- */

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-IN");
}

function renderHero(quote) {
  els.heroSymbol.textContent = state.symbol;
  els.heroExch.textContent = `${state.exch} · ${state.exchType}`;
  els.heroLtp.textContent = fmtNum(quote.ltp);
  const change = quote.ltp - quote.prevClose;
  const pct = quote.prevClose ? (change / quote.prevClose) * 100 : 0;
  const up = change >= 0;
  els.heroChange.textContent = `${up ? "+" : ""}${fmtNum(change)} (${up ? "+" : ""}${fmtNum(pct)}%)`;
  els.heroChange.className = "hero-change" + (up ? "" : " down");
  els.heroTime.textContent = new Date(quote.time || Date.now()).toLocaleTimeString("en-IN");

  setVal("volume", fmtInt(quote.volume));
  setVal("bidAsk", `${fmtNum(quote.bid)} / ${fmtNum(quote.ask)}`);
  setVal("prevClose", fmtNum(quote.prevClose));
  setVal("open", fmtNum(quote.open));
}

function renderHeikinAshi(ha) {
  if (!ha) return;
  const bull = ha.haClose >= ha.haOpen;
  const bodyTopVal = Math.max(ha.haOpen, ha.haClose);
  const bodyBotVal = Math.min(ha.haOpen, ha.haClose);
  const range = ha.haHigh - ha.haLow || 1;
  const toY = (v) => 85 - ((v - ha.haLow) / range) * 80;

  els.haWick.setAttribute("y1", toY(ha.haHigh));
  els.haWick.setAttribute("y2", toY(ha.haLow));
  els.haBody.setAttribute("y", toY(bodyTopVal));
  els.haBody.setAttribute("height", Math.max(2, toY(bodyBotVal) - toY(bodyTopVal)));
  els.haBody.setAttribute("fill", bull ? "#2FBF71" : "#E5484D");

  document.getElementById("haCandleBox").title =
    `Heikin-Ashi  O:${fmtNum(ha.haOpen)} H:${fmtNum(ha.haHigh)} L:${fmtNum(ha.haLow)} C:${fmtNum(ha.haClose)}`;
}

/* ---------------- pollers ---------------- */

async function pollQuote() {
  try {
    const q = await api(`/api/quote/${state.exch}/${state.exchType}/${state.symbol}`);
    renderHero(q);
    setConn("live");
  } catch (e) {
    console.error(e);
    setConn("down");
  }
}

async function pollCandles() {
  try {
    const candles = await api(`/api/historical/${state.exch}/${state.exchType}/${state.symbol}?interval=5m`);
    if (!Array.isArray(candles) || candles.length === 0) return;

    const closes = candles.map((c) => c.close);
    const ma7 = sma(closes, 7);
    const ma20 = sma(closes, 20);
    const prevMa7 = sma(closes.slice(0, -1), 7);
    const prevMa20 = sma(closes.slice(0, -1), 20);

    setVal("ma7", fmtNum(ma7));
    setVal("ma20", fmtNum(ma20));

    const cross = detectCrossover(prevMa7, prevMa20, ma7, ma20);
    renderCross(els.maCrossValue, cross, "price");

    const vwap = vwapFromCandles(candles);
    setVal("vwap", fmtNum(vwap));

    const ha = computeHeikinAshi(candles);
    renderHeikinAshi(ha);
  } catch (e) {
    console.error(e);
  }
}

async function pollOptionChain() {
  try {
    const data = await api(`/api/optionchain/${state.symbol}`);
    // expected: { totalCeOi, totalPeOi, oi, oiOpen }
    const pcr = data.totalCeOi ? data.totalPeOi / data.totalCeOi : null;
    setVal("pcr", pcr !== null ? fmtNum(pcr) : "—");
    setVal("oi", fmtInt(data.oi));

    const oiChangePct = data.oiOpen ? ((data.oi - data.oiOpen) / data.oiOpen) * 100 : null;
    setVal(
      "oiChangePct",
      oiChangePct !== null ? `${oiChangePct >= 0 ? "+" : ""}${fmtNum(oiChangePct)}%` : "—",
      oiChangePct !== null ? (oiChangePct >= 0 ? "bull" : "bear") : ""
    );

    // OI-series crossover (client-persisted history)
    const hist = pushOiHistory(state.oiHistoryKey, data.oi);
    const oiSeries = hist.map((h) => h.oi);
    const oiMa7 = sma(oiSeries, 7);
    const oiMa20 = sma(oiSeries, 20);
    const prevOiMa7 = sma(oiSeries.slice(0, -1), 7);
    const prevOiMa20 = sma(oiSeries.slice(0, -1), 20);
    const oiCross = detectCrossover(prevOiMa7, prevOiMa20, oiMa7, oiMa20);
    renderCross(els.oiCrossValue, oiCross, "OI");
  } catch (e) {
    console.error(e);
  }
}

function renderCross(el, cross, label) {
  if (!cross) {
    el.textContent = "not enough data yet";
    el.className = "cross-value";
    return;
  }
  const map = {
    bull: [`▲ Golden cross — 7MA crossed above 20MA (${label})`, "bull"],
    bear: [`▼ Death cross — 7MA crossed below 20MA (${label})`, "bear"],
    above: [`7MA above 20MA (${label})`, "bull"],
    below: [`7MA below 20MA (${label})`, "bear"],
  };
  const [text, cls] = map[cross];
  el.textContent = text;
  el.className = "cross-value " + cls;
}

/* ---------------- lifecycle ---------------- */

function stopTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

function startSymbol(rawSymbol, exchCombo) {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!symbol) return;
  const [exch, exchType] = exchCombo.split("_");

  stopTimers();
  state.symbol = symbol;
  state.exch = exch;
  state.exchType = exchType;
  state.oiHistoryKey = `oi-history:${exch}:${exchType}:${symbol}`;

  buildCards();
  setConn("connecting");
  els.heroSymbol.textContent = symbol;

  pollQuote();
  pollCandles();
  pollOptionChain();

  state.timers.push(setInterval(pollQuote, CONFIG.QUOTE_POLL_MS));
  state.timers.push(setInterval(pollCandles, CONFIG.CANDLE_POLL_MS));
  state.timers.push(setInterval(pollOptionChain, CONFIG.OPTIONCHAIN_POLL_MS));
}

els.loadBtn.addEventListener("click", () => startSymbol(els.symbolInput.value, els.exchSelect.value));
els.symbolInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startSymbol(els.symbolInput.value, els.exchSelect.value);
});

els.footNote.textContent = `Proxy: ${CONFIG.API_BASE}`;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

// default starting symbol
buildCards();
startSymbol("RELIANCE", "N_C");
