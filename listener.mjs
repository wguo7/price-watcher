// Telegram chat listener: long-polls the bot for William's messages 24/7 and
// hands them (text, screenshots as Telegram file ids, and confirmation-button taps) to the chat "brain" workflow in wguo7/stock-agents (private),
// which runs Claude and replies. Runs in self-restarting ~5h shifts on free
// public-repo minutes. Deliberately logs message COUNTS only, never content.
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const PAT = process.env.XREPO_PAT;          // cross-repo dispatch to stock-agents
const GH_TOKEN = process.env.GITHUB_TOKEN;  // self-restart in this repo
const REF = process.env.REF_NAME || 'main';
const CHAT_REF = process.env.CHAT_REF || REF; // branch of stock-agents to run the brain on
const BRAIN_REPO = 'wguo7/stock-agents';
const SHIFT_MS = 300 * 60 * 1000; // 5h; workflow timeout is 350 min
const API = 'https://api.github.com';
const TG = `https://api.telegram.org/bot${TG_TOKEN}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(method, params) {
  try {
    const r = await fetch(`${TG}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(70000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) {
    return { status: 0, body: {} };
  }
}

const alert = (text) => tg('sendMessage', { chat_id: TG_CHAT, text });

async function dispatch(repo, workflow, ref, inputs, token) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        body: JSON.stringify({ ref, ...(inputs ? { inputs } : {}) }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 204) return true;
      console.log(`dispatch ${repo}/${workflow}: HTTP ${r.status}`);
    } catch (e) {
      console.log(`dispatch ${repo}/${workflow}: ${e.message}`);
    }
    await sleep(2000 * 2 ** i);
  }
  return false;
}

async function brainBusy() {
  for (const status of ['in_progress', 'queued']) {
    try {
      const r = await fetch(
        `${API}/repos/${BRAIN_REPO}/actions/workflows/chat.yml/runs?status=${status}&per_page=1`,
        { headers: { authorization: `Bearer ${PAT}` }, signal: AbortSignal.timeout(20000) },
      );
      if (r.ok && (await r.json()).total_count > 0) return true;
    } catch { /* treat as not busy */ }
  }
  return false;
}

// If the brain's last run failed (usage limit hit — queued in chat/pending.json
// on its side), re-dispatch it every ~15 min until a run succeeds. A retry run
// with nothing queued is a no-op success, so this always converges.
let lastRetryAt = 0;
async function maybeRetryPending() {
  if (Date.now() - lastRetryAt < 15 * 60 * 1000) return;
  try {
    const r = await fetch(
      `${API}/repos/${BRAIN_REPO}/actions/workflows/chat.yml/runs?status=completed&per_page=1`,
      { headers: { authorization: `Bearer ${PAT}` }, signal: AbortSignal.timeout(20000) },
    );
    if (!r.ok) return;
    const runs = (await r.json()).workflow_runs || [];
    if (!runs.length || runs[0].conclusion !== 'failure') return;
    if (await brainBusy()) return;
    lastRetryAt = Date.now();
    if (await dispatch(BRAIN_REPO, 'chat.yml', CHAT_REF, null, PAT)) {
      console.log('brain last run failed — dispatched a retry');
    }
  } catch { /* transient — try again next cycle */ }
}

// William's messages, screenshots and button taps (nobody else's). Screenshots/PDFs travel as
// Telegram file ids (the brain downloads them; nothing is stored here). A tap on a confirmation
// button (stock-agents tools/send.mjs --confirm) arrives as callback data "c|<kind>|<arg>".
const fromWilliam = (chatId) => String(chatId) === String(TG_CHAT);
function toMessage(u) {
  const m = u.message;
  if (m && fromWilliam(m.chat?.id)) {
    const photos = [];
    if (m.photo?.length) photos.push(m.photo[m.photo.length - 1].file_id); // largest size
    if (m.document && /^(image\/|application\/pdf)/.test(m.document.mime_type || '')) photos.push(m.document.file_id);
    return {
      text: m.text || m.caption || (photos.length ? '[screenshot]' : '[non-text message]'),
      date: m.date,
      message_id: m.message_id,
      ...(photos.length ? { photos } : {}),
    };
  }
  const q = u.callback_query;
  if (q && fromWilliam(q.message?.chat?.id)) {
    return { text: `[button] ${q.data}`, date: Math.floor(Date.now() / 1000), message_id: q.message?.message_id, callback: q.data, _query: q };
  }
  return null;
}
const collect = (updates) => updates.map(toMessage).filter(Boolean);

// acknowledge taps at once (stops the spinner) and remove the tapped button so it cannot be
// pressed twice; the brain sends the confirmation a few seconds later
async function acknowledgeTaps(msgs) {
  for (const m of msgs.filter((x) => x._query)) {
    const q = m._query;
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Recording…' });
    const rows = (q.message?.reply_markup?.inline_keyboard || []).map((row) => row.filter((b) => b.callback_data !== q.data)).filter((row) => row.length);
    await tg('editMessageReplyMarkup', { chat_id: TG_CHAT, message_id: q.message?.message_id, reply_markup: { inline_keyboard: rows } });
    delete m._query;
  }
  return msgs;
}

async function main() {
  if (!TG_TOKEN || !TG_CHAT) { console.log('TG_TOKEN/TG_CHAT secrets missing'); process.exit(1); }
  if (!PAT) {
    await alert('⚠️ Chat bridge: the XREPO_PAT secret is missing in wguo7/price-watcher. Add it (Settings → Secrets and variables → Actions) and re-run the chat-listener workflow.');
    return;
  }
  await tg('deleteWebhook', {});
  // explicit, because Telegram keeps the last allowed_updates it was given: messages + button taps
  const ALLOWED = ['message', 'callback_query'];
  let offset = 0;
  let conflicts = 0;
  const end = Date.now() + SHIFT_MS;

  while (Date.now() < end) {
    await maybeRetryPending();
    const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ALLOWED });
    if (r.status === 409) {
      // another getUpdates consumer is active (overlapping listener run)
      conflicts++;
      if (conflicts >= 8) { console.log('another listener is active — exiting without chaining'); return; }
      await sleep(30000);
      continue;
    }
    conflicts = 0;
    if (!r.body?.ok) {
      if (r.status !== 0) console.log(`getUpdates not ok: HTTP ${r.status}`);
      await sleep(10000);
      continue;
    }
    const updates = r.body.result || [];
    if (!updates.length) continue;
    offset = updates[updates.length - 1].update_id + 1;
    let msgs = await acknowledgeTaps(collect(updates));
    if (!msgs.length) continue;

    // instant acknowledgment: 👍 William's last typed message (taps were answered above), then typing
    const typed = msgs.filter((m) => !m.callback);
    if (typed.length) {
      await tg('setMessageReaction', {
        chat_id: TG_CHAT,
        message_id: typed[typed.length - 1].message_id,
        reaction: [{ type: 'emoji', emoji: '👍' }],
      });
    }
    await tg('sendChatAction', { chat_id: TG_CHAT, action: 'typing' });

    // brief drain so rapid follow-up texts (and the rest of a multi-screenshot album) land in the same exchange
    await sleep(typed.some((m) => m.photos) ? 4000 : 1500);
    const r2 = await tg('getUpdates', { offset, timeout: 0, allowed_updates: ALLOWED });
    if (r2.body?.ok && r2.body.result?.length) {
      offset = r2.body.result[r2.body.result.length - 1].update_id + 1;
      msgs = msgs.concat(await acknowledgeTaps(collect(r2.body.result)));
    }

    // serialize exchanges: wait (max 10 min) for the previous brain run to finish
    const waitEnd = Date.now() + 10 * 60 * 1000;
    while (Date.now() < waitEnd && (await brainBusy())) await sleep(10000);

    const ok = await dispatch(BRAIN_REPO, 'chat.yml', CHAT_REF, { updates: JSON.stringify(msgs) }, PAT);
    if (ok) console.log(`handed off ${msgs.length} message(s) to the chat brain`);
    else await alert("⚠️ Chat bridge couldn't hand your message to the agent (dispatch failed) — it was NOT answered. Check that XREPO_PAT has access to stock-agents.");
  }

  // shift over. Telegram only drops updates once a later getUpdates asks for a higher offset, so
  // confirm the last batch now — else the next shift (offset 0) gets it again and re-dispatches it
  if (offset) await tg('getUpdates', { offset, timeout: 0, allowed_updates: ALLOWED });
  // restart self so coverage continues
  const chained = await dispatch(process.env.GITHUB_REPOSITORY, 'chat-listener.yml', REF, null, GH_TOKEN);
  if (!chained) await alert('⚠️ Chat listener could not restart itself — start the chat-listener workflow manually in price-watcher → Actions.');
}

main().catch(async (e) => {
  console.log('listener crashed:', e.message);
  process.exit(1);
});
