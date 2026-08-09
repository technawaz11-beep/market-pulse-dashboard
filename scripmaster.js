// Downloads 5paisa's public ScripMaster once, caches it in memory + on disk,
// and resolves (exch, exchType, symbol) -> numeric ScripCode.
// Needed because historicalData() and the option-chain calls want a ScripCode,
// while market feed can take the symbol string directly.

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const CACHE_FILE = path.join(__dirname, ".scripmaster-cache.json");
const SCRIP_MASTER_URL = "https://openapi.5paisa.com/VendorsAPI/Service1.svc/ScripMaster/segment/All";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // refresh daily

let cache = null; // { fetchedAt, bySymbol: { "N|C|RELIANCE": "2885", ... } }

function keyFor(exch, exchType, symbol) {
  return `${exch.toUpperCase()}|${exchType.toUpperCase()}|${symbol.toUpperCase()}`;
}

async function loadFromDisk() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function downloadAndBuild() {
  const res = await fetch(SCRIP_MASTER_URL);
  if (!res.ok) throw new Error(`ScripMaster download failed: HTTP ${res.status}`);
  const rows = await res.json();

  const bySymbol = {};
  // Field names vary slightly by feed version; guard with fallbacks.
  for (const row of rows) {
    const exch = row.Exch || row.exchange;
    const exchType = row.ExchType || row.exchangeType;
    const symbol = row.Symbol || row.symbol || row.Name;
    const scripCode = row.ScripCode || row.scripcode;
    if (!exch || !exchType || !symbol || !scripCode) continue;
    bySymbol[keyFor(exch, exchType, symbol)] = String(scripCode);
  }

  const payload = { fetchedAt: Date.now(), bySymbol };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  return payload;
}

async function ensureLoaded() {
  if (cache && Date.now() - cache.fetchedAt < MAX_AGE_MS) return cache;

  const disk = await loadFromDisk();
  if (disk && Date.now() - disk.fetchedAt < MAX_AGE_MS) {
    cache = disk;
    return cache;
  }

  cache = await downloadAndBuild();
  return cache;
}

async function resolveScripCode(exch, exchType, symbol) {
  const c = await ensureLoaded();
  const code = c.bySymbol[keyFor(exch, exchType, symbol)];
  if (!code) throw new Error(`Symbol not found in ScripMaster: ${exch}/${exchType}/${symbol}`);
  return code;
}

module.exports = { resolveScripCode };
