// Sovereign BTC Stack v2 — read-only monitoring server. MIT License. No dependencies.
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
    if (!await tcp(svc.host, svc.port)) return { up: false };
    try { return { up: true, height: await electrumTip(svc.host, svc.port) }; }
    catch { return { up: true, note: 'Indexing — tip not available yet' }; }
  },
  async mempool(svc) {
    try { const r = await get(`http://${svc.host}:${svc.port}/api/v1/blocks/tip/height`);
      if (r.code >= 500) return { up: false, note: 'API error ' + r.code };
      const h = parseInt(r.body, 10); return { up: true, api: true, height: isNaN(h) ? undefined : h };
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
  async tcp(svc) { return { up: await tcp(svc.host, svc.port) }; },
  async ui(svc) { if (!UI_PROBE_HOST || !svc.uiPort) return { up: null }; return { up: await tcp(UI_PROBE_HOST, svc.uiPort) }; }
};

function detectInstalled(id) {
  if (!APP_DATA_DIR) return null;   // unknown: fall back to reachability
  try { return fs.statSync(path.join(APP_DATA_DIR, id)).isDirectory(); } catch { return false; }
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
// status: ok | warn | down | waiting | unknown
function evaluate(id, r, nodeHeight) {
  if (r.up === false) return { status: 'down', reason: r.note || 'Not reachable' };
  if (r.up === null) return { status: 'unknown', reason: 'Installed (no health probe)' };
  if (id === 'bitcoin' || id === 'bitcoin-knots') {
    if (r.ibd || (r.sync != null && r.sync < 99.9)) return { status: 'warn', reason: `Syncing ${r.sync}%` };
    if (r.peers === 0) return { status: 'warn', reason: 'No peers' };
    return { status: 'ok', reason: r.height != null ? 'Synced' : 'Up' };
  }
  if (r.walletState !== undefined) {
    if (['NON_EXISTING', 'WAITING_TO_START'].includes(r.walletState)) return { status: 'waiting', reason: 'Waiting for wallet' };
    if (r.walletState === 'LOCKED') return { status: 'waiting', reason: 'Wallet locked' };
    if (r.synced === false) return { status: 'warn', reason: 'Syncing to chain' };
    return { status: 'ok', reason: 'Running' };
  }
  if (r.api === false) return { status: 'down', reason: 'API not answering' };
  if (r.height != null && nodeHeight != null && nodeHeight - r.height > 3) return { status: 'warn', reason: `${(nodeHeight - r.height).toLocaleString()} blocks behind node` };
  return { status: 'ok', reason: r.note || 'Up' };
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
function build(results, sys) {
  const nodeSlot = cfg.slots.find(s => s.id === 'node');
  const nodeId = nodeSlot.options.find(o => results[o] && results[o].installed);
  const nodeHeight = nodeId ? results[nodeId].data.height : null;
  const slots = cfg.slots.map(sl => {
    const opts = sl.options.map(id => {
      const svc = cfg.services[id], r = results[id] || { installed: false, data: {} };
      const ev = r.installed ? evaluate(id, r.data, nodeHeight) : { status: 'available', reason: 'Not installed' };
      if (r.installed) { record(id, ev.status !== 'down'); alert(id, ev); }
      return { id, label: svc.label, installed: r.installed, uiPort: svc.uiPort, ...ev, data: r.installed ? r.data : {}, history: (hist[id] || []).map(b => +(b.up / b.n).toFixed(2)) };
    });
    const active = opts.filter(o => o.installed);
    return { id: sl.id, label: sl.label, active, others: opts.filter(o => !o.installed) };
  });
  const st = Object.fromEntries(slots.map(s => [s.id, s.active.length ? s.active[0].status : 'empty']));
  const links = cfg.links.map(l => {
    const a = st[l.from], b = st[l.to]; let status = 'ok';
    if (a === 'empty' || b === 'empty') status = 'empty'; else if (a === 'down' || b === 'down') status = 'down'; else if (a === 'warn' || b === 'warn' || a === 'waiting' || b === 'waiting') status = 'warn';
    return { ...l, status };
  });
  return { updated: new Date().toISOString(), demo: DEMO, slots, links, system: sys };
}
async function poll() {
  const results = {};
  await Promise.all(Object.entries(cfg.services).map(async ([id, svc]) => {
    const inst = detectInstalled(id);
    if (inst === false) return results[id] = { installed: false, data: {} };
    let data = { up: null };
    try { data = await (probes[svc.probe] || probes.tcp)(svc); } catch { data = { up: false }; }
    // without the app-data mount, "installed" means "answers on its port"
    results[id] = { installed: inst === true || data.up === true, data };
  }));
  state = build(results, system()); saveHist();
}

// ---------- demo ----------
const SCEN = ['all-green', 'mempool-down', 'core-syncing', 'lnd-waiting', 'knots'];
function demoState(sc) {
  const H = 921400, r = {}, I = (data) => ({ installed: true, data: { up: true, ...data } }), N = { installed: false, data: {} };
  for (const id of Object.keys(cfg.services)) r[id] = N;
  r.bitcoin = I({ height: H, headers: H, sync: 100, ibd: false, peers: 10, version: '/Satoshi:29.0.0/', mempoolTx: 41230, mempoolMB: 92.4, diskGB: 742.1, pruned: false });
  r.electrs = I({ height: H }); r.mempool = I({ height: H, api: true });
  r.lightning = I({ walletState: 'SERVER_ACTIVE', synced: true, height: H, channels: 4, pending: 0, peers: 6, alias: 'NodeMaster' });
  r['ride-the-lightning'] = I({ up: null });
  if (sc === 'mempool-down') r.mempool = { installed: true, data: { up: false } };
  if (sc === 'core-syncing') { const h = 312000; r.bitcoin.data = { ...r.bitcoin.data, height: h, sync: 12.0, ibd: true, diskGB: 98.3, mempoolTx: 0, mempoolMB: 0 };
    r.electrs.data = { up: true, height: 290000 }; r.mempool.data = { up: true, api: true, height: h }; r.lightning.data = { up: true, walletState: 'NON_EXISTING' }; }
  if (sc === 'lnd-waiting') { r.lightning.data = { up: true, walletState: 'NON_EXISTING' }; r['ride-the-lightning'] = N; }
  if (sc === 'knots') { r['bitcoin-knots'] = { installed: true, data: { ...r.bitcoin.data, version: '/Satoshi:28.1.0/Knots:20250305/' } }; r.bitcoin = N; }
  const sys = { memTotal: 8.4e9, memAvail: sc === 'core-syncing' ? 2.9e9 : 4.6e9, swapTotal: 4.3e9, swapUsed: sc === 'core-syncing' ? 0.6e9 : 0.1e9, load: [1.2, 1.4, 1.3], cpus: 4, tempC: 56.4,
    disk: { path: '/mnt/data', total: 2e12, free: sc === 'core-syncing' ? 1.85e12 : 1.12e12 }, uptime: 360000 };
  const s = build(r, sys);
  // fake history so sparklines show something
  for (const sl of s.slots) for (const o of sl.active) o.history = Array.from({ length: 48 }, (_, i) => o.status === 'down' && i > 40 ? 0 : (i === 20 && o.id === 'mempool' ? 0.6 : 1));
  return { ...s, scenario: sc, scenarios: SCEN };
}

// ---------- http (GET only) ----------
const PUB = path.join(__dirname, 'public');
http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET' }); return res.end('read-only'); }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/status') {
    const body = DEMO ? demoState(SCEN.includes(u.searchParams.get('scenario')) ? u.searchParams.get('scenario') : 'all-green') : state;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(body));
  }
  const f = path.join(PUB, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(f); res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream' }); res.end(d); });
}).listen(PORT, () => console.log(`Sovereign BTC Stack v2.1 on :${PORT}${DEMO ? ' (DEMO)' : ''}${RPC ? ' (RPC configured)' : ''}`));
if (!DEMO) { poll(); setInterval(poll, POLL); }
