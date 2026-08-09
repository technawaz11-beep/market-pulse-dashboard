// Thin wrapper around the official `5paisajs` SDK.
// Holds the session, logs in via TOTP, and re-logs-in once a day
// (5paisa sessions are valid for the trading day).
//
// NOTE: exact method names below match the 5paisajs SDK docs at the time
// this was written (fetch_market_feed_by_scrip, historicalData, get_TOTP_Session).
// 5paisa has changed SDK method names across versions before — if a call
// throws "not a function", run `node -e "console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(require('5paisajs').FivePaisaClient.prototype)))"`
// to list what your installed version actually exposes, and adjust here.

const { FivePaisaClient } = require("5paisajs");
const { authenticator } = require("otplib");

let client = null;
let loggedInOnDay = null;

function buildClient() {
  return new FivePaisaClient({
    appSource: process.env.FIVEPAISA_APP_SOURCE,
    appName: process.env.FIVEPAISA_APP_NAME,
    userId: process.env.FIVEPAISA_USER_ID,
    password: process.env.FIVEPAISA_PASSWORD,
    userKey: process.env.FIVEPAISA_USER_KEY,
    encryptionKey: process.env.FIVEPAISA_ENCRYPTION_KEY,
    clientCode: process.env.FIVEPAISA_CLIENT_CODE,
  });
}

async function ensureLogin() {
  const today = new Date().toISOString().slice(0, 10);
  if (client && loggedInOnDay === today) return client;

  const fresh = buildClient();
  const totp = authenticator.generate(process.env.FIVEPAISA_TOTP_SECRET);

  const res = await fresh.get_TOTP_Session(
    process.env.FIVEPAISA_CLIENT_CODE,
    totp,
    process.env.FIVEPAISA_CLIENT_PIN
  );

  const ok = res && (res.status === 0 || res.status === "0");
  if (!ok) {
    throw new Error("5paisa TOTP login failed: " + JSON.stringify(res));
  }

  client = fresh;
  loggedInOnDay = today;
  return client;
}

module.exports = { ensureLogin };
