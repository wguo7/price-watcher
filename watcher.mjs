#!/usr/bin/env node
// Continuous price watcher. Polls holdings every SWEEP_SECS, watchlist every
// 5th sweep, alerts Telegram when a configured level or move threshold trips.
// Each alert fires at most once per rule per shift. Exits at END_CT (Chicago).
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const END_CT = process.env.END_CT || "15:05"; // Chicago HH:MM to stop at
const SWEEP_SECS = 60;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(t, attempt = 1) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=10d`,
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
    const closes = (r.indicators.quote[0].close || []).filter((c) => c != null);
    let prev = null;
    if (closes.length >= 2) {
      const last = closes[closes.length - 1];
      prev = Math.abs(last - price) / price < 0.0001 ? closes[closes.length - 2] : last;
    }
    return { price, dayPct: prev ? ((price - prev) / prev) * 100 : 0 };
  } catch { return null; }
}

const fired = new Set();
async function alert(key, text) {
  if (fired.has(key)) return;
  fired.add(key);
  console.log(`ALERT ${key}: ${text.replace(/\n/g, " | ")}`);
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
  } catch (e) { console.error("telegram send failed:", e.message); fired.delete(key); }
}

const fmt = (n) => n.toFixed(2);
let sweepN = 0;
console.log(`Watcher up. Sweep=${SWEEP_SECS}s, ends ${END_CT} CT. Levels:`, JSON.stringify(cfg.portfolio));

while (chicagoNow() < END_CT) {
  sweepN++;
  for (const [t, lv] of Object.entries(cfg.portfolio)) {
    const q = await quote(t);
    if (!q) continue;
    if (lv.below && q.price <= lv.below)
      await alert(`${t}-below`, `🚨 BUY LEVEL HIT: ${t} $${fmt(q.price)} crossed below your $${fmt(lv.below)} level (day ${q.dayPct >= 0 ? "+" : ""}${fmt(q.dayPct)}%).\nDo: if the plan still holds, place your limit buy now. Check news first if the drop is sharp.`);
    if (lv.above && q.price >= lv.above)
      await alert(`${t}-above`, `📈 SELL/TRIM LEVEL HIT: ${t} $${fmt(q.price)} crossed above your $${fmt(lv.above)} level (day ${q.dayPct >= 0 ? "+" : ""}${fmt(q.dayPct)}%).\nDo: consider trimming per plan, or raise the level if the thesis strengthened.`);
    if (Math.abs(q.dayPct) >= cfg.portfolioDayMovePct)
      await alert(`${t}-daymove`, `🚨 BIG MOVE: ${t} ${q.dayPct >= 0 ? "+" : ""}${fmt(q.dayPct)}% today, now $${fmt(q.price)}.\nDo: check the news before acting — the 12:30/3:15 agent will add context.`);
    await sleep(150);
  }
  const ix = await quote(cfg.index);
  if (ix && Math.abs(ix.dayPct) >= cfg.indexMovePct)
    await alert("index-move", `🚨 MARKET MOVE: S&P 500 ${ix.dayPct >= 0 ? "+" : ""}${fmt(ix.dayPct)}% today (${fmt(ix.price)}).\nDo: nothing rash. If down 5%+ from recent high, remember the rule: pull the next VTI buy forward.`);
  if (sweepN % 5 === 1) {
    for (const t of cfg.watchlist) {
      const q = await quote(t);
      if (!q) continue;
      if (q.dayPct <= -cfg.watchlistDropPct)
        await alert(`${t}-dip`, `👀 DIP: ${t} ${fmt(q.dayPct)}% today, now $${fmt(q.price)}.\nDo: possible entry — check why it's down before buying. Ask Claude for a read.`);
      await sleep(300);
    }
  }
  await sleep(SWEEP_SECS * 1000);
}
console.log(`Reached ${END_CT} CT — shift over. Alerts fired: ${fired.size}`);
