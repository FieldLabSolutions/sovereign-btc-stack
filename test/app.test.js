'use strict';
const test = require('node:test'), assert = require('node:assert'), { spawn } = require('child_process');
const net = require('net'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
function start(env, port) {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), PRICE_ENABLED: '0', REFERENCE_TIP_URL: '', HISTORY_FILE: path.join(os.tmpdir(), `sbs-h-${port}.json`), ...env } });
  return new Promise(r => p.stdout.on('data', d => { if (/on :/.test(d)) r(p); }));
}
const j = async (port, q = '') => (await fetch(`http://127.0.0.1:${port}/api/status${q}`)).json();
const svc = (s, id) => s.slots.flatMap(x => x.active.concat(x.others)).find(o => o.id === id);
const link = (s, f, t) => s.links.find(l => l.from === f && l.to === t);

test('demo scenarios', async t => {
  const p = await start({ DEMO: '1' }, 39811);
  try {
    const h = await j(39811, '?scenario=healthy');
    assert.equal(svc(h, 'electrs').status, 'ok');
    assert.equal(svc(h, 'datum').status, 'ok');
    assert.equal(svc(h, 'etbc-pool').status, 'ok');
    assert.equal(svc(h, 'miner-controller').status, 'ok');
    assert.equal(link(h, 'node', 'datum').status, 'ok');
    assert.equal(link(h, 'datum', 'mining').status, 'ok');
    const ix = await j(39811, '?scenario=electrs-indexing');
    assert.equal(svc(ix, 'electrs').status, 'warn');
    assert.equal(svc(ix, 'electrs').reason, 'Still building its index');
    assert.equal(link(ix, 'indexer', 'explorer').status, 'warn');
    const dm = await j(39811, '?scenario=datum-missing');
    assert.equal(svc(dm, 'datum').installed, false);
    assert.equal(link(dm, 'node', 'datum').status, 'empty');
    assert.equal(svc(dm, 'miner-controller').status, 'unknown');
    assert.equal((await j(39811, '?scenario=electrs-down')).slots.find(s => s.id === 'indexer').active[0].status, 'down');
    for (const [f, ct] of [['/favicon.ico', 'image/x-icon'], ['/favicon.svg', 'image/svg+xml'], ['/favicon-32.png', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
      const r = await fetch('http://127.0.0.1:39811' + f); assert.equal(r.status, 200, f); assert.equal(r.headers.get('content-type'), ct);
    }
    const html = await (await fetch('http://127.0.0.1:39811/')).text();
    assert.match(html, /<head>[\s\S]*rel="icon" href="\/favicon.ico"[\s\S]*<\/head>/);
    assert.match(html, /rel="apple-touch-icon"/);
    assert.equal((await fetch('http://127.0.0.1:39811/api/status', { method: 'POST' })).status, 405);
  } finally { p.kill(); }
});

test('live probes: installed-but-unreachable is gray, closed Electrum port while UI up is amber, reachable is green', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-'));
  for (const a of ['electrs', 'fieldlab-etbc-pool', 'fieldlab-miner-controller', 'datum']) fs.mkdirSync(path.join(dir, a));
  const listen = () => new Promise(r => { const s = net.createServer(c => c.end()).listen(0, '127.0.0.1', () => r(s)); });
  const ui = await listen(), pool = await listen(), dead = 1; // port 1: nothing listens
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json')));
  cfg.services.electrs = { ...cfg.services.electrs, host: '127.0.0.1', port: dead, uiPort: ui.address().port };
  cfg.services['etbc-pool'].targets = [['127.0.0.1', pool.address().port]];
  cfg.services['miner-controller'].targets = [['127.0.0.1', dead]]; cfg.services['miner-controller'].uiPort = dead;
  cfg.services.datum.targets = [['127.0.0.1', dead]]; cfg.services.datum.port = dead; cfg.services.datum.uiPort = dead;
  const cf = path.join(dir, 'c.json'); fs.writeFileSync(cf, JSON.stringify(cfg));
  const p = await start({ CONFIG: cf, APP_DATA_DIR: dir, UI_PROBE_HOST: '127.0.0.1' }, 39812);
  try {
    let s; for (let i = 0; i < 40; i++) { s = await j(39812); if (s.updated) break; await new Promise(r => setTimeout(r, 250)); }
    assert.equal(svc(s, 'electrs').status, 'warn'); assert.equal(svc(s, 'electrs').reason, 'Still building its index');
    assert.equal(svc(s, 'etbc-pool').status, 'ok');
    assert.equal(svc(s, 'miner-controller').status, 'unknown');
    assert.equal(svc(s, 'datum').status, 'unknown');
    assert.notEqual(link(s, 'node', 'datum').status, 'down');
  } finally { p.kill(); ui.close(); pool.close(); }
});
