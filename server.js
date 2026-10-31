// Sovereign BTC Stack v2.4.0 — read-only monitoring server. MIT License. No dependencies.
'use strict';
const http = require('http'), https = require('https'), net = require('net'), fs = require('fs'), os = require('os'), path = require('path');
const PORT = +process.env.PORT || 3880;
const DEMO = process.env.DEMO === '1';
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG || path.join(__dirname, 'config.json'), 'utf8'));
const POLL = Math.max(10, cfg.pollSeconds || 15) * 1000;
const APP_DATA_DIR = process.env.APP_DATA_DIR || '';          // Umbrel app-data, mounted read-only (optional)
const DATA_PATH = process.env.DATA_PATH || '/mnt/data';        // disk to report in System panel
const UI_PROBE_HOST = process.env.UI_PROBE_HOST || '';         // host to probe app UIs on (optional)
const HIST_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'data', 'history.json');
const ALERT_URL = process.env.ALERT_WEBHOOK_URL || (cfg.alerts && cfg.alerts.enabled ? cfg.alerts.webhookUrl : '');
const RPC = process.env.BITCOIN_RPC_USER && process.env.BITCOIN_RPC_PASS ? {
  host: process.env.BITCOIN_RPC_HOST, port: +process.env.BITCOIN_RPC_PORT || 0,
  auth: 'Basic ' + Buffer.from(process.env.BITCOIN_RPC_USER + ':' + process.env.BITCOIN_RPC_PASS).toString('base64')
} : null;                                                       // credentials never logged or sent to the browser
const LND_MAC = process.env.LND_READONLY_MACAROON_HEX || '';   // optional readonly.macaroon (hex)

// ---------- probes (all read-only) ----------
const tcp = (host, port, ms = 3000) => new Promise(r => {
  const s = net.connect({ host, port }); const done = ok => { s.destroy(); r(ok); };
  s.setTimeout(ms, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false));
});
function get(url, { headers = {}, ms = 5000, insecure = false } = {}) {
  return new Promise((res, rej) => {
    const lib = url.startsWith('https') ? https : http;
    const q = lib.get(url, { headers, timeout: ms, rejectUnauthorized: !insecure }, r => {
      let d = ''; r.on('data', c => { if (d.length < 2e6) d += c; }); r.on('end', () => res({ code: r.statusCode, body: d }));
    });
    q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', rej);
  });
}
function rpc(host, port, method) {   // bitcoind JSON-RPC; only read methods are ever called
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'ss', method, params: [] });
    const q = http.request({ host, port, method: 'POST', timeout: 6000, headers: { Authorization: RPC.auth, 'Content-Type': 'application/json' } }, r => {
      let d = ''; r.on('data', c => { if (d.length < 1e6) d += c; });
      r.on('end', () => { try { const j = JSON.parse(d); j.error ? rej(new Error('rpc')) : res(j.result); } catch { rej(new Error('rpc reply')); } });
    });
    q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', rej); q.end(body);
  });
}
function electrumTip(host, port, ms = 5000) {   // Electrum protocol: read-only headers subscribe
  return new Promise((res, rej) => {
    const s = net.connect({ host, port }); let buf = '';
    const t = setTimeout(() => { s.destroy(); rej(new Error('timeout')); }, ms);
    s.on('connect', () => s.write(JSON.stringify({ id: 1, method: 'blockchain.headers.subscribe', params: [] }) + '\n'));
    s.on('data', d => { buf += d; const line = buf.split('\n').find(l => l.includes('"id":1') || l.includes('"id": 1'));
      if (line) { clearTimeout(t); s.destroy(); try { res(JSON.parse(line).result.height); } catch { rej(new Error('bad')); } } });
    s.on('error', e => { clearTimeout(t); rej(e); });
  });
}

const probes = {
  async 'bitcoin-rpc'(svc) {
    const host = (RPC && RPC.host) || svc.host, port = (RPC && RPC.port) || svc.port;
    const up = await tcp(host, port); if (!up) return { up: false };
    if (!RPC) return { up: true, note: 'Port only. Set BITCOIN_RPC_USER/PASS for details.' };
    try {
      const [bc, ni, mp] = await Promise.all(['getblockchaininfo', 'getnetworkinfo', 'getmempoolinfo'].map(m => rpc(host, port, m)));
      return { up: true, height: bc.blocks, headers: bc.headers, sync: +(bc.verificationprogress * 100).toFixed(2), ibd: bc.initialblockdownload,
        peers: ni.connections, version: ni.subversion, mempoolTx: mp.size, mempoolMB: +(mp.bytes / 1e6).toFixed(1),
        diskGB: +(bc.size_on_disk / 1e9).toFixed(1), pruned: bc.pruned };
    } catch { return { up: true, note: 'RPC not answering yet' }; }
  },
  async electrum(svc) {
    if (!await tcp(svc.host, svc.port)) {
      // Electrs/Fulcrum do not open the Electrum port until the initial index is built.
      // If its web UI answers, it is running and indexing; otherwise we still can't tell building from broken.
      const ui = UI_PROBE_HOST && svc.uiPort ? await tcp(UI_PROBE_HOST, svc.uiPort) : null;
      if (ui === false) return { up: false, note: 'Not answering (Electrum port and web page both closed)' };
      return { up: true, indexing: true, note: 'Still building its index' };
    }
    try { return { up: true, height: await electrumTip(svc.host, svc.port) }; }
    catch { return { up: true, note: 'Indexing — tip not available yet' }; }
  },
  async mempool(svc) {
    try { const r = await get(`http://${svc.host}:${svc.port}/api/v1/blocks/tip/height`);
      if (r.code >= 500) return { up: false, note: 'API error ' + r.code };
      const h = parseInt(r.body, 10), out = { up: true, api: true, height: isNaN(h) ? undefined : h };
      try { const b = JSON.parse((await get(`http://${svc.host}:${svc.port}/api/v1/blocks`)).body); // newest block first
        if (Array.isArray(b) && b[0] && b[0].timestamp) out.tipTime = b[0].timestamp; } catch {}
      try { const m = JSON.parse((await get(`http://${svc.host}:${svc.port}/api/mempool`)).body); if (m && m.count != null) out.mempoolTx = m.count; } catch {}
      try { const f = JSON.parse((await get(`http://${svc.host}:${svc.port}/api/v1/fees/recommended`)).body); if (f && f.fastestFee != null) out.fees = { fast: f.fastestFee, hour: f.hourFee, eco: f.economyFee }; } catch {}
      return out;
    } catch { return { up: await tcp(svc.host, svc.port), api: false }; }
  },
  async lnd(svc) {
    const base = `https://${svc.host}:${svc.port}`;
    try {
      const st = JSON.parse((await get(base + '/v1/state', { insecure: true })).body).state; // unauthenticated, read-only
      const out = { up: true, walletState: st };
      if (LND_MAC && (st === 'SERVER_ACTIVE' || st === 'RPC_ACTIVE')) {
        try { const gi = JSON.parse((await get(base + '/v1/getinfo', { insecure: true, headers: { 'Grpc-Metadata-macaroon': LND_MAC } })).body);
          Object.assign(out, { synced: gi.synced_to_chain, height: gi.block_height, channels: gi.num_active_channels, pending: gi.num_pending_channels, peers: gi.num_peers, alias: gi.alias });
        } catch {}
      }
      return out;
    } catch { return { up: await tcp(svc.host, svc.port) }; }
  },
  async reach(svc) { // TCP check: container hostnames on Umbrel's network first, then UI_PROBE_HOST:uiPort/port
    const t = [...(svc.targets || [])]; if (UI_PROBE_HOST) for (const p of [svc.port, svc.uiPort]) if (p) t.push([UI_PROBE_HOST, p]);
    if (!t.length) return { up: null };
    for (const [h, p] of t) if (await tcp(h, p, 2000)) return { up: true, via: p };
    return { up: false, unreachable: true };
  },
  async tcp(svc) { return { up: await tcp(svc.host, svc.port) }; },
  async ui(svc) { if (!UI_PROBE_HOST || !svc.uiPort) return { up: null }; return { up: await tcp(UI_PROBE_HOST, svc.uiPort) }; }
};

function detectInstalled(id) {
  if (!APP_DATA_DIR) return null;   // unknown: fall back to reachability
  const ids = [cfg.services[id].appId || id];
  try { return ids.some(a => { try { return fs.statSync(path.join(APP_DATA_DIR, a)).isDirectory(); } catch { return false; } }); } catch { return false; }
}

// ---------- optional public reference tip (works fine without outbound internet) ----------
const REF_URL = process.env.REFERENCE_TIP_URL === undefined ? 'https://mempool.space/api/blocks/tip/height' : process.env.REFERENCE_TIP_URL;
let refTip = { height: null, at: 0 };
async function referenceTip() {
  if (!REF_URL) return null;
  if (Date.now() - refTip.at < 5 * 60e3) return refTip.height;
  refTip.at = Date.now();
  try { const r = await get(REF_URL, { ms: 4000 }); const h = parseInt(r.body, 10); refTip.height = r.code === 200 && h > 0 ? h : null; } catch { refTip.height = null; }
  return refTip.height;
}

// ---------- optional BTC price (outbound to a public price API; PRICE_ENABLED=0 turns it off) ----------
const PRICE_ON = !['0', 'false', 'off', 'no'].includes(String(process.env.PRICE_ENABLED ?? (cfg.price && cfg.price.enabled === false ? '0' : '1')).toLowerCase());
let price = { usd: null, at: 0, source: null, tried: 0 };
async function fetchPrice() {
  if (!PRICE_ON) return null;
  if (Date.now() - price.tried < 60e3) return price;
  price.tried = Date.now();
  const mp = cfg.services.mempool, srcs = [];
  if (mp) srcs.push(['your Mempool', `http://${mp.host}:${mp.port}/api/v1/prices`, b => b.USD]);
  srcs.push(['mempool.space', 'https://mempool.space/api/v1/prices', b => b.USD],
            ['Coinbase', 'https://api.coinbase.com/v2/prices/BTC-USD/spot', b => b.data && +b.data.amount]);
  for (const [name, url, pick] of srcs) {
    try { const r = await get(url, { ms: 4000 }); if (r.code !== 200) continue;
      const v = +pick(JSON.parse(r.body)); if (v > 0) { price = { usd: v, at: Date.now(), source: name, tried: price.tried }; break; } } catch {}
  }
  return price;
}
function priceOut(p) { // never hand out an old number as current: drop it after 30 min
  if (!PRICE_ON) return { enabled: false };
  if (!p || !p.usd || Date.now() - p.at > 30 * 60e3) return { enabled: true, usd: null };
  return { enabled: true, usd: p.usd, at: new Date(p.at).toISOString(), source: p.source };
}

// ---------- system ----------
function system() {
  const mi = {}; try { for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) { const [k, v] = l.split(':'); if (v) mi[k] = parseInt(v, 10) * 1024; } } catch {}
  let temp = null; try { temp = +(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8') / 1000).toFixed(1); } catch {}
  let disk = null; try { const s = fs.statfsSync(DATA_PATH); disk = { path: DATA_PATH, total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
  return { memTotal: mi.MemTotal || os.totalmem(), memAvail: mi.MemAvailable || os.freemem(), swapTotal: mi.SwapTotal || 0,
    swapUsed: (mi.SwapTotal || 0) - (mi.SwapFree || 0), load: os.loadavg().map(x => +x.toFixed(2)), cpus: os.cpus().length, tempC: temp, disk, uptime: os.uptime() };
}

// ---------- evaluation ----------
// status: ok | warn | down | waiting | unknown.  Every status carries a plain-words `guide`.
const GUIDE = {
  bitcoin: 'The Bitcoin node checks every block and feeds all the other apps.',
  'bitcoin-knots': 'The Bitcoin node checks every block and feeds all the other apps.',
  electrs: 'Electrs indexes addresses so wallets and Mempool can look up balances.',
  fulcrum: 'Fulcrum indexes addresses so wallets and Mempool can look up balances.',
  mempool: 'Mempool is your private block explorer, reading from your own node.',
  lightning: 'LND runs your Lightning node for fast, cheap payments.',
  'core-lightning': 'Core Lightning runs your Lightning node for fast, cheap payments.',
  'ride-the-lightning': 'A web page for managing Lightning channels.',
  thunderhub: 'A web page for managing Lightning channels.',
  'etbc-pool': 'Your solo mining pool. Miners send work here; it gets block templates from the node.',
  datum: 'DATUM Gateway builds block templates from your own node and hands them to your miners over stratum.',
  'miner-controller': 'Controls your miners (modes, schedules, heat rules).'
};
// Chain evidence when there is no RPC login: Mempool's tip height + tip block time, Electrs height, optional public tip.
function chainEvidence(results, ref) {
  const mp = results.mempool && results.mempool.installed ? results.mempool.data : {};
  const ex = ['electrs', 'fulcrum'].map(i => results[i]).find(r => r && r.installed);
  const ev = { mempoolH: mp.height, tipTime: mp.tipTime, indexH: ex ? ex.data.height : undefined, ref };
  ev.tipAgeH = ev.tipTime ? (Date.now() / 1000 - ev.tipTime) / 3600 : null;
  const best = Math.max(...[ev.mempoolH, ev.indexH].filter(x => x != null), -1);
  ev.best = best >= 0 ? best : null;
  if (ref && ev.best != null && ref - ev.best > 3) { ev.syncing = true; ev.pct = +(ev.best / ref * 100).toFixed(1); ev.behind = ref - ev.best; }
  else if (ev.tipAgeH != null && ev.tipAgeH > 3) { ev.syncing = true; ev.tipDate = new Date(ev.tipTime * 1000).toISOString().slice(0, 10); }
  else if (ev.tipAgeH != null || (ref && ev.best != null)) ev.atTip = true;
  return ev;
}
function evaluate(id, r, ctx) {
  const g = GUIDE[id] || '';
  if (r.unreachable) return { status: 'unknown', reason: "Installed · can't reach it yet", guide: `${g} Umbrel lists it, but this dashboard can't reach it yet (still starting, or on another network). Shown gray, not red, until it answers.` };
  if (r.up === false) return { status: 'down', reason: r.note || 'Not reachable', guide: `${g} It is not answering. Open it in Umbrel and restart it if it stays red.` };
  if (r.up === null) return { status: 'unknown', reason: 'Installed (no health probe yet)', guide: `${g} This dashboard can't check its health yet, so it shows gray, not green.` };
  if (id === 'bitcoin' || id === 'bitcoin-knots') {
    if (r.headers != null) {   // full RPC data
      if (r.ibd || (r.sync != null && r.sync < 99.9)) return { status: 'warn', reason: `Syncing ${r.sync}%`, guide: `${g} It is still downloading the chain. Electrs, Mempool and Lightning will be behind until it finishes. Nothing to fix.` };
      if (r.peers === 0) return { status: 'warn', reason: 'No peers', guide: `${g} It has no connections to other nodes. Check the internet/Tor connection.` };
      return { status: 'ok', reason: 'Synced', guide: `${g} Fully synced.` };
    }
    const e = ctx.ev;
    if (e.syncing) return { status: 'warn', reason: 'Syncing - catching up', sync: e.pct, evidence: true,
      guide: `${g} It is still downloading the chain${e.pct != null ? ` (about ${e.pct}%, ${e.behind.toLocaleString()} blocks to go)` : e.tipDate ? ` (newest block it has is from ${e.tipDate})` : ''}. Electrs and Mempool will be behind until it finishes. Nothing to fix.` };
    if (e.atTip) return { status: 'ok', reason: 'Up · at chain tip (checked via Mempool)', guide: `${g} Mempool shows it at the current tip.` };
    return { status: 'warn', reason: "Up · can't verify sync", guide: `${g} It is running, but without Mempool or an RPC login this dashboard can't tell if it is synced.` };
  }
  if (r.walletState !== undefined) {
    if (['NON_EXISTING', 'WAITING_TO_START'].includes(r.walletState)) return { status: 'waiting', reason: 'Waiting for wallet', guide: `${g} No wallet yet. Open LND in Umbrel and create it; write the 24 words on paper.` };
    if (r.walletState === 'LOCKED') return { status: 'waiting', reason: 'Wallet locked', guide: `${g} The wallet is locked. Open LND in Umbrel to unlock it.` };
    if (r.synced === false) return { status: 'warn', reason: 'Syncing to chain', guide: `${g} It is catching up to the node. Nothing to fix.` };
    if (r.synced === undefined) return { status: ctx.ev.syncing ? 'warn' : 'ok', reason: ctx.ev.syncing ? 'Running · node still syncing' : 'Running', guide: ctx.ev.syncing ? `${g} It can't fully work until the node finishes syncing.` : `${g} Running.` };
    return { status: 'ok', reason: 'Running', guide: `${g} Running and synced.` };
  }
  if (r.api === false) return { status: 'down', reason: 'API not answering', guide: `${g} The port is open but its API is not answering. Restart it in Umbrel if it stays red.` };
  if (id === 'electrs' || id === 'fulcrum') {
    if (r.height == null) return { status: 'warn', reason: 'Still building its index', guide: `${g} It is building its index and can't answer lookups yet.${ctx.ev.syncing ? ' It has to wait for the node to finish syncing first.' : ''} Nothing to fix.` };
  }
  const top = ctx.ev.ref || ctx.nodeHeight || ctx.ev.best;
  if (r.height != null && top != null && top - r.height > 3) return { status: 'warn', reason: `${(top - r.height).toLocaleString()} blocks behind`, guide: `${g} It is behind the chain tip${ctx.ev.syncing ? ' because the node is still syncing' : ''}. It will catch up on its own.` };
  if (ctx.ev.syncing && id === 'mempool') return { status: 'warn', reason: 'Up · following a syncing node', guide: `${g} It shows the node's current (old) tip until the node finishes syncing. Nothing to fix.` };
  return { status: 'ok', reason: r.note || 'Up', guide: `${g} Working.` };
}

// Link health: is the downstream actually getting what it needs from the upstream?
function linkHealth(l, S) {
  const A = S[l.from], B = S[l.to], an = A && A.label, bn = B && B.label;
  if (!A || !B) return { status: 'empty', guide: `${!A ? 'Nothing' : an} → ${!B ? 'nothing' : bn}: not installed.` };
  if (A.status === 'down') return { status: 'down', guide: `${bn} can't reach ${an} because ${an} is down. Fix ${an} first.` };
  if (B.status === 'down') return { status: 'down', guide: `${bn} is down, so it is not getting data from ${an}. Restart ${bn} in Umbrel.` };
  if (A.status === 'unknown' || B.status === 'unknown') return { status: 'unknown', guide: `Can't check the ${an} → ${bn} link yet.` };
  if (B.status === 'waiting') return { status: 'waiting', guide: `${bn} is waiting (${B.reason.toLowerCase()}) before it uses ${an}.` };
  if (A.status === 'waiting') return { status: 'waiting', guide: `${an} is waiting (${A.reason.toLowerCase()}), so ${bn} has nothing to use yet.` };
  if (l.to === 'explorer' && l.from === 'indexer' && B.id && A.data.height == null) return { status: 'warn', guide: `${an} is still indexing, so Mempool address lookups won't work yet. Nothing to fix.` };
  if (A.status === 'warn') return { status: 'warn', guide: `${an} is not fully ready (${A.reason}), so ${bn} is behind too. Nothing to fix.` };
  if (B.status === 'warn') return { status: 'warn', guide: `${bn} is behind ${an} (${B.reason}). It will catch up.` };
  if (A.status === 'ok' && B.status === 'ok') return { status: 'ok', guide: `${an} → ${bn}: working.` };
  return { status: 'unknown', guide: `Can't verify the ${an} → ${bn} link.` };
}

// ---------- history (ring buffer of buckets, persisted) ----------
const BUCKET = (cfg.bucketMinutes || 5) * 60e3, NB = Math.round((cfg.historyHours || 24) * 3600e3 / BUCKET);
let hist = {}; try { hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
function record(id, ok) {
  const b = Math.floor(Date.now() / BUCKET) * BUCKET, h = hist[id] = hist[id] || [];
  let last = h[h.length - 1]; if (!last || last.t !== b) { last = { t: b, up: 0, n: 0 }; h.push(last); }
  last.n++; if (ok) last.up++; while (h.length > NB) h.shift();
}
function saveHist() { try { fs.mkdirSync(path.dirname(HIST_FILE), { recursive: true }); fs.writeFileSync(HIST_FILE + '.tmp', JSON.stringify(hist)); fs.renameSync(HIST_FILE + '.tmp', HIST_FILE); } catch {} }

// ---------- alerts (off by default) ----------
const lastStatus = {};
function alert(id, s) {
  if (!ALERT_URL || lastStatus[id] === undefined || lastStatus[id] === s.status) { lastStatus[id] = s.status; return; }
  lastStatus[id] = s.status;
  try { const u = new URL(ALERT_URL); const q = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
    q.on('error', () => {}); q.end(JSON.stringify({ service: id, status: s.status, detail: s.reason })); } catch {}
}

// ---------- poll ----------
let state = { updated: null, demo: DEMO, slots: [], links: [], system: null };
function build(results, sys, ref, pr) {
  const nodeSlot = cfg.slots.find(s => s.id === 'node');
  const nodeId = nodeSlot.options.find(o => results[o] && results[o].installed);
  const nodeHeight = nodeId && results[nodeId].data.headers != null ? results[nodeId].data.height : null;
  const ctx = { ev: chainEvidence(results, ref), nodeHeight };
  const slots = cfg.slots.map(sl => {
    const opts = sl.options.map(id => {
      const svc = cfg.services[id], r = results[id] || { installed: false, data: {} };
      const ev = r.installed ? evaluate(id, r.data, ctx) : { status: 'available', reason: 'Not installed', guide: GUIDE[id] || '' };
      if (r.installed) { record(id, ev.status !== 'down'); alert(id, ev); }
      const data = r.installed ? { ...r.data } : {};
      if (ev.sync != null && data.sync == null) data.sync = ev.sync;
      const appId = svc.appId || id, storeUrl = appId.startsWith('fieldlab-') ? `https://github.com/FieldLabSolutions/fieldlab-umbrel-store/tree/main/${appId}` : `https://apps.umbrel.com/app/${appId}`;
      return { id, label: svc.label, installed: r.installed, uiPort: svc.uiPort, storeUrl, ...ev, data, history: (hist[id] || []).map(b => +(b.up / b.n).toFixed(2)) };
    });
    const active = opts.filter(o => o.installed);
    return { id: sl.id, label: sl.label, active, others: opts.filter(o => !o.installed) };
  });
  const S = Object.fromEntries(slots.map(s => [s.id, s.active[0]]));
  const links = cfg.links.map(l => ({ ...l, ...linkHealth(l, S) }));
  return { updated: new Date().toISOString(), demo: DEMO, slots, links, system: sys,
    chain: { referenceTip: ref || null, mempoolTip: ctx.ev.mempoolH ?? null, indexTip: ctx.ev.indexH ?? null,
      mempoolTx: (results.mempool && results.mempool.data.mempoolTx) ?? null, fees: (results.mempool && results.mempool.data.fees) || null },
    price: priceOut(pr) };
}
async function poll() {
  const results = {};
  const refP = referenceTip(), prP = fetchPrice().catch(() => null);
  await Promise.all(Object.entries(cfg.services).map(async ([id, svc]) => {
    const inst = detectInstalled(id);
    if (inst === false) return results[id] = { installed: false, data: {} };
    let data = { up: null };
    try { data = await (probes[svc.probe] || probes.tcp)(svc); } catch { data = { up: false }; }
    // without the app-data mount, "installed" means "answers on its port"
    results[id] = { installed: inst === true || data.up === true, data };
  }));
  state = build(results, system(), await refP, await prP); saveHist();
}

// ---------- demo ----------
const SCEN = ['healthy', 'syncing-no-rpc', 'syncing-rpc', 'electrs-indexing', 'electrs-down', 'mempool-down', 'lnd-waiting', 'datum-missing', 'cant-verify', 'knots'];
function demoState(sc, pq) {
  const H = 921400, now = Date.now() / 1000, r = {}, I = (data) => ({ installed: true, data: { up: true, ...data } }), N = { installed: false, data: {} };
  for (const id of Object.keys(cfg.services)) r[id] = N;
  let ref = H;
  r.bitcoin = I({ height: H, headers: H, sync: 100, ibd: false, peers: 10, version: '/Satoshi:29.0.0/', mempoolTx: 41230, mempoolMB: 92.4, diskGB: 742.1, pruned: false });
  r.electrs = I({ height: H }); r.mempool = I({ height: H, api: true, tipTime: now - 420, mempoolTx: 41230, fees: { fast: 6, hour: 3, eco: 1 } });
  r.lightning = I({ walletState: 'SERVER_ACTIVE', synced: true, height: H, channels: 4, pending: 0, peers: 6, alias: 'NodeMaster' });
  r['ride-the-lightning'] = I({ up: null });
  r.datum = I({ via: 23334 }); r['etbc-pool'] = I({ via: 3333 }); r['miner-controller'] = I({ via: 8080 });
  const noRpc = () => { r.bitcoin.data = { up: true, note: 'Port only. Set BITCOIN_RPC_USER/PASS for details.' }; };
  if (sc === 'syncing-no-rpc') { noRpc(); r.electrs.data = { up: true, note: 'Indexing — tip not available yet' };
    r.mempool.data = { up: true, api: true, height: 679149, tipTime: 1617000000 }; r.lightning.data = { up: true, walletState: 'NON_EXISTING' }; r['ride-the-lightning'] = N; }
  if (sc === 'syncing-rpc') { const h = 442780; r.bitcoin.data = { ...r.bitcoin.data, height: h, sync: 12.4, ibd: true, diskGB: 98.3, mempoolTx: 0, mempoolMB: 0 };
    r.electrs.data = { up: true, height: 430000 }; r.mempool.data = { up: true, api: true, height: h, tipTime: 1480000000 }; r.lightning.data = { up: true, walletState: 'NON_EXISTING' }; }
  if (sc === 'electrs-indexing') r.electrs.data = { up: true, indexing: true, note: 'Still building its index' };
  if (sc === 'datum-missing') { r.datum = N; r['miner-controller'] = { installed: true, data: { up: false, unreachable: true } }; }
  if (sc === 'electrs-down') r.electrs = { installed: true, data: { up: false } };
  if (sc === 'mempool-down') r.mempool = { installed: true, data: { up: false } };
  if (sc === 'lnd-waiting') { r.lightning.data = { up: true, walletState: 'NON_EXISTING' }; r['ride-the-lightning'] = N; }
  if (sc === 'cant-verify') { noRpc(); r.mempool = N; r.electrs = N; ref = null; r.lightning.data = { up: true, walletState: 'RPC_ACTIVE' }; }
  if (sc === 'knots') { r['bitcoin-knots'] = { installed: true, data: { ...r.bitcoin.data, version: '/Satoshi:28.1.0/Knots:20250305/' } }; r.bitcoin = N; }
  const sys = { memTotal: 8.4e9, memAvail: 4.6e9, swapTotal: 4.3e9, swapUsed: 0.1e9, load: [1.2, 1.4, 1.3], cpus: 4, tempC: 56.4, disk: { path: '/mnt/data', total: 2e12, free: 1.12e12 }, uptime: 360000 };
  const pr = pq === 'na' ? null : { usd: 97412.35, at: Date.now() - (pq === 'old' ? 7 * 60e3 : 20e3), source: 'mempool.space' };
  const s = build(r, sys, ref, pr);
  for (const sl of s.slots) for (const o of sl.active) o.history = Array.from({ length: 48 }, (_, i) => o.status === 'down' && i > 40 ? 0 : 1);
  return { ...s, scenario: sc, scenarios: SCEN };
}

// ---------- http (GET only) ----------
const PUB = path.join(__dirname, 'public');
http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET' }); return res.end('read-only'); }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/status') {
    const body = DEMO ? demoState(SCEN.includes(u.searchParams.get('scenario')) ? u.searchParams.get('scenario') : 'healthy', u.searchParams.get('price')) : state;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(body));
  }
  const f = path.join(PUB, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(f); res.writeHead(200, { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400', 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }[ext] || 'application/octet-stream' }); res.end(d); });
}).listen(PORT, () => console.log(`Sovereign BTC Stack v2.4.0 on :${PORT}${DEMO ? ' (DEMO)' : ''}${RPC ? ' (RPC configured)' : ''}`));
if (!DEMO) { poll(); setInterval(poll, POLL); }
