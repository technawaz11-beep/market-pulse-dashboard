require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ensureLogin } = require("./fivepaisa");
const { resolveScripCode } = require("./scripmaster");

const app = express();
const PORT = process.env.PORT || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

app.use(cors({ origin: ALLOWED_ORIGIN }));

// Baseline OI captured at first request of the day, per symbol — used for OI-change%.
// In-memory only: fine for a single-user dashboard; swap for a small DB/file if you
// need it to survive server restarts mid-day.
const oiBaseline = new Map(); // key: `${symbol}|${day}` -> oi

function todayKey(symbol) {
  const day = new Date().toISOString().slice(0, 10);
  return `${symbol}|${day}`;
}

/* ---------------------------------------------------------------------- */
/* Quote: LTP, volume, bid/ask, open, previous close                       */
/* ---------------------------------------------------------------------- */
app.get("/api/quote/:exch/:exchType/:symbol", async (req, res) => {
  try {
    const { exch, exchType, symbol } = req.params;
    const client = await ensureLogin();

    const feedReq = [
      { Exch: exch.toUpperCase(), ExchType: exchType.toUpperCase(), ScripCode: "0", ScripData: `${symbol.toUpperCase()}_EQ` },
    ];
    const feed = await client.fetch_market_feed_by_scrip(feedReq);
    const d = feed?.Data?.[0] || feed?.body?.Data?.[0];
    if (!d) throw new Error("Empty market feed response");

    res.json({
      symbol: symbol.toUpperCase(),
      ltp: Number(d.LastRate ?? d.LTP),
      volume: Number(d.TotalQty ?? d.Volume ?? 0),
      bid: Number(d.BidRate ?? d.Bid ?? 0),
      ask: Number(d.OffRate ?? d.Ask ?? 0),
      open: Number(d.Open ?? 0),
      prevClose: Number(d.PClose ?? d.PreviousClose ?? 0),
      high: Number(d.High ?? 0),
      low: Number(d.Low ?? 0),
      time: Date.now(),
    });
  } catch (err) {
    console.error("quote error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------------- */
/* Historical candles (for VWAP / MA7 / MA20 / Heikin-Ashi)                */
/* ---------------------------------------------------------------------- */
app.get("/api/historical/:exch/:exchType/:symbol", async (req, res) => {
  try {
    const { exch, exchType, symbol } = req.params;
    const interval = req.query.interval || "5m";
    const client = await ensureLogin();
    const scripCode = await resolveScripCode(exch, exchType, symbol);

    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 5); // last 5 days is plenty for 7/20-period MAs on intraday bars

    const fmt = (d) => d.toISOString().slice(0, 10);
    const raw = await client.historicalData(exch.toLowerCase(), exchType.toLowerCase(), scripCode, interval, fmt(from), fmt(to));

    const rows = raw?.data ?? raw?.Data ?? raw ?? [];
    const candles = rows.map((r) => ({
      time: r.Datetime ?? r.Date ?? r.time,
      open: Number(r.Open ?? r.open),
      high: Number(r.High ?? r.high),
      low: Number(r.Low ?? r.low),
      close: Number(r.Close ?? r.close),
      volume: Number(r.Volume ?? r.volume ?? 0),
    }));

    res.json(candles);
  } catch (err) {
    console.error("historical error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------------- */
/* Option chain: total CE OI, total PE OI, current OI, PCR, OI% change     */
/* ---------------------------------------------------------------------- */
app.get("/api/optionchain/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const client = await ensureLogin();

    const expiries = await client.get_expiry("N", symbol.toUpperCase());
    const nearestExpiry = expiries?.Expiry?.[0]?.ExpiryDate ?? expiries?.[0]?.ExpiryDate;
    if (!nearestExpiry) throw new Error("Could not resolve nearest expiry");

    const chain = await client.get_option_chain("N", symbol.toUpperCase(), nearestExpiry);
    const rows = chain?.Options ?? chain?.data ?? chain ?? [];

    let totalCeOi = 0;
    let totalPeOi = 0;
    for (const row of rows) {
      const oi = Number(row.OpenInterest ?? row.OI ?? 0);
      const type = (row.CPType ?? row.OptionType ?? "").toUpperCase();
      if (type === "CE" || type === "C") totalCeOi += oi;
      if (type === "PE" || type === "P") totalPeOi += oi;
    }
    const totalOi = totalCeOi + totalPeOi;

    const key = todayKey(symbol.toUpperCase());
    if (!oiBaseline.has(key)) oiBaseline.set(key, totalOi);
    const oiOpen = oiBaseline.get(key);

    res.json({
      symbol: symbol.toUpperCase(),
      expiry: nearestExpiry,
      totalCeOi,
      totalPeOi,
      oi: totalOi,
      oiOpen,
    });
  } catch (err) {
    console.error("optionchain error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Market Pulse proxy listening on :${PORT}`);
});
