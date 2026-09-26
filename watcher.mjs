#!/usr/bin/env node
// Continuous price watcher. Polls holdings every SWEEP_SECS, watchlist every
// 5th sweep, alerts Telegram when a configured level or move threshold trips.
// A rule fires once per DAY (both shifts share state/alerts.json in this repo, written via
// the contents API); a move alert re-fires only if the move grows by REFIRE_STEP points.
// Exits at END_CT (Chicago).
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const END_CT = process.env.END_CT || "15:05"; // Chicago HH:MM to stop at
const SWEEP_SECS = 60;
// When set, every alert is also handed to the chat brain (stock-agents), which
// texts William a compiled BUY/PASS/WATCH verdict a minute later.
const PAT = process.env.XREPO_PAT;
const CHAT_REF = process.env.CHAT_REF || "main";
const BRAIN_REPO = "wguo7/stock-agents";
const GH_API = "https://api.github.com";
const GH_TOKEN = process.env.GITHUB_TOKEN;        // this repo: shared alert state across shifts
const REPO = process.env.GITHUB_REPOSITORY;
const STATE_PATH = "state/alerts.json";
const REFIRE_STEP = 1.5; // percentage points a move must grow before the same ticker re-alerts

if (!TG_TOKEN || !TG_CHAT) {
  console.error("Missing TG_TOKEN / TG_CHAT");
  process.exit(1);
}

const chicagoNow = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour12: false,
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("hour")}:${get("minute")}`;
};

const chicagoDate = (ms = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(ms)); // YYYY-MM-DD

// A quote is LIVE only once today's regular session has traded. Before the
// 8:30 CT open (and on holidays/weekends) Yahoo still serves yesterday's close
// with yesterday's day%, so any alert on it is a stale re-fire: pure noise.
const isLive = (meta, nowMs = Date.now()) => {
  const t = meta?.regularMarketTime, start = meta?.currentTradingPeriod?.regular?.start;
  if (!Number.isFinite(t) || !Number.isFinite(start)) return false;
  return t >= start && chicagoDate(t * 1000) === chicagoDate(nowMs);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(t, attempt = 1) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } },
    );
    if (res.status === 429) {
      if (attempt <= 2) { await sleep(20000); return quote(t, attempt + 1); }
      return null;
    }
    if (!res.ok) return null;
    const j = await res.json();
    const r = j.chart.result[0];
    const price = r.meta.regularMarketPrice;
    const prev = r.meta.chartPreviousClose; // with range=1d: the previous session's close
    return { price, dayPct: prev ? ((price - prev) / prev) * 100 : 0, live: isLive(r.meta), tradedAt: r.meta.regularMarketTime };
  } catch { return null; }
}

// ---- shared alert state (one file per repo, reset each Chicago day) ----
const fired = new Set(); // this shift's alerts (for the end-of-shift count)
export async function loadState() {
  const empty = { date: chicagoDate(), alerts: {} };
  if (!GH_TOKEN || !REPO) return { state: empty, sha: null };
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${STATE_PATH}`, { headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return { state: empty, sha: null };
    const j = await r.json();
    const state = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
    return { state: state.date === empty.date ? state : empty, sha: j.sha };
  } catch { return { state: empty, sha: undefined }; } // unreadable: fall back to this shift's memory
}
export async function saveState(state, sha) {
  if (!GH_TOKEN || !REPO || sha === undefined) return false;
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${STATE_PATH}`, {
      method: "PUT", headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json" },
      body: JSON.stringify({ message: `watcher alert state ${state.date}`, content: Buffer.from(JSON.stringify(state, null, 1)).toString("base64"), ...(sha ? { sha } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch { return false; }
}
/** Should this alert go out? Level alerts: once a day. Move alerts: again only when |move| grew by REFIRE_STEP in the same direction. */
export function shouldFire(prev, move) {
  if (!prev) return true;
  if (move == null || prev.move == null) return false;
  return Math.sign(move) === Math.sign(prev.move) && Math.abs(move) >= Math.abs(prev.move) + REFIRE_STEP;
}
const local = {}; // what THIS shift has sent (also the fallback when the shared file can't be read)
export async function alert(key, text, move = null) {
  let rec = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, sha } = await loadState();
    const prev = state.alerts[key] || local[key];
    if (!shouldFire(prev, move)) return;
    rec = state.alerts[key] = { move, at: chicagoNow() };
    if (sha === undefined || (await saveState(state, sha))) break; // saved (or no shared state): send
    // a failed save (409: the other shift wrote first, a timeout) retries on fresh state; after the
    // last try it sends anyway rather than stay silent
  }
  // remember it only now that it is going out: recording it before the save succeeded made the
  // retry see its own unsent record and return, which dropped the alert and muted the rule all day
  local[key] = rec;
  fired.add(key);
  console.log(`ALERT ${key}: ${text.replace(/\n/g, " | ")}`);
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
  } catch (e) { console.error("telegram send failed:", e.message); fired.delete(key); return; }
  queueAnalysis(`${text.split("\n")[0]}`);
}

// ---- auto-analysis: hand fired alerts to the chat brain for a clear verdict ----
let analysisQueue = [];
let lastAnalysisAt = 0;
function queueAnalysis(line) { if (PAT) analysisQueue.push(line); }

async function brainBusy() {
  for (const status of ["in_progress", "queued"]) {
    try {
      const r = await fetch(
        `${GH_API}/repos/${BRAIN_REPO}/actions/workflows/chat.yml/runs?status=${status}&per_page=1`,
        { headers: { authorization: `Bearer ${PAT}` }, signal: AbortSignal.timeout(15000) },
      );
      if (r.ok && (await r.json()).total_count > 0) return true;
    } catch { return true; /* can't tell — don't risk clobbering a queued user message */ }
  }
  return false;
}

async function flushAnalysis() {
  if (!PAT || !analysisQueue.length) return;
  if (Date.now() - lastAnalysisAt < 5 * 60 * 1000) return; // at most one hand-off per 5 min
  if (await brainBusy()) return; // never displace a queued user-message run
  const lines = analysisQueue.join("\n");
  const msg = [{
    text: `🤖 WATCHER (automated): these alert(s) just fired — send William a compiled verdict, not homework:\n${lines}`,
    date: Math.floor(Date.now() / 1000),
  }];
  try {
    const r = await fetch(`${GH_API}/repos/${BRAIN_REPO}/actions/workflows/chat.yml/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${PAT}`, accept: "application/vnd.github+json" },
      body: JSON.stringify({ ref: CHAT_REF, inputs: { updates: JSON.stringify(msg) } }),
      signal: AbortSignal.timeout(20000),
    });
    console.log(`analysis hand-off: HTTP ${r.status} (${analysisQueue.length} alert(s))`);
    if (r.status === 204) { analysisQueue = []; lastAnalysisAt = Date.now(); }
  } catch (e) { console.log("analysis hand-off failed:", e.message); }
}

const fmt = (n) => n.toFixed(2);
let sweepN = 0;
console.log(`Watcher up. Sweep=${SWEEP_SECS}s, ends ${END_CT} CT. Levels:`, JSON.stringify(cfg.portfolio));

let wasLive = null;
const MAIN = process.argv[1]?.replace(/\\/g, "/").endsWith("watcher.mjs"); // tests import shouldFire
while (MAIN && chicagoNow() < END_CT) {
  sweepN++;
  // one probe decides whether today's session has traded yet; until it has,
  // every quote is yesterday's close and nothing may fire
  const probe = await quote(Object.keys(cfg.portfolio)[0] || cfg.index);
  if (probe && !probe.live) {
    if (wasLive !== false) console.log(`${chicagoNow()} CT: session not open yet (last trade ${new Date(probe.tradedAt * 1000).toISOString()}) - no alerts on stale prints`);
    wasLive = false;
    await sleep(SWEEP_SECS * 1000);
    continue;
  }
  if (probe && wasLive !== true) { console.log(`${chicagoNow()} CT: session live - watching`); wasLive = true; }
  for (const [t, lv] of Object.entries(cfg.portfolio)) {
    const q = await quote(t);
    if (!q || !q.live) continue;
    if (lv.below && q.price <= lv.below)
      await alert(`${t}-below`, `🚨 BUY LEVEL HIT: ${t} $${fmt(q.price)} crossed below your $${fmt(lv.below)} level (day ${q.dayPct >= 0 ? "+" : ""}${fmt(q.dayPct)}%).\nDo: if the plan still holds, place your limit buy now. Check news first if the drop is sharp.`);
    if (lv.above && q.price >= lv.above)
      await alert(`${t}-above`, `📈 SELL/TRIM LEVEL HIT: ${t} $${fmt(q.price)} crossed above your $${fmt(lv.above)} level (day ${q.dayPct >= 0 ? "+" : ""}${fmt(q.dayPct)}%).\nDo: consider trimming per plan, or raise the level if the thesis strengthened.`);
    if (Math.abs(q.dayPct) >= cfg.portfolioDayMovePct)
      await alert(`${t}-daymove`, `🚨 BIG MOVE: ${t} ${q.dayPct >= 0 ? "+" : ""}${fmt(q.dayPct)}% today, now $${fmt(q.price)}.\nDo: check the news before acting — the 12:30/3:15 agent will add context.`, q.dayPct);
    await sleep(150);
  }
  const ix = await quote(cfg.index);
  if (ix && ix.live && Math.abs(ix.dayPct) >= cfg.indexMovePct)
    await alert("index-move", `🚨 MARKET MOVE: S&P 500 ${ix.dayPct >= 0 ? "+" : ""}${fmt(ix.dayPct)}% today (${fmt(ix.price)}).\nDo: nothing rash. If down 5%+ from recent high, remember the rule: pull the next VTI buy forward.`, ix.dayPct);
  if (sweepN % 5 === 1) {
    for (const t of cfg.watchlist) {
      const q = await quote(t);
      if (!q || !q.live) continue;
      if (q.dayPct <= -cfg.watchlistDropPct)
        await alert(`${t}-dip`, `👀 DIP: ${t} ${fmt(q.dayPct)}% today, now $${fmt(q.price)}.\nDo: hold on — analyzing now, clear verdict coming in ~2 min.`, q.dayPct);
      await sleep(300);
    }
  }
  await flushAnalysis();
  await sleep(SWEEP_SECS * 1000);
}
if (MAIN) console.log(`Reached ${END_CT} CT — shift over. Alerts fired: ${fired.size}`);
