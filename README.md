# Sovereign BTC Stack (v2.4.0)
Read-only monitoring dashboard for a Bitcoin node (built for "Node Master", Umbrel on Raspberry Pi 5).
Each slot (Node, Indexer, Explorer, Lightning, Lightning UI, Mining) shows only the app that is detected;
alternatives sit behind a small "See other options" button. Tap a service for its detail view.
Part dashboard, part guide: every box and every flagged line has a plain-words line saying what the part does, what is wrong, and what to do.

**Lines (v2.2) show real link health, not just "both ends up":**
- green solid: verified working
- amber: upstream still syncing or downstream behind / still indexing
- red broken (dashed + ✕): downstream can't communicate with upstream (one end down / API not answering)
- blue: waiting on you (e.g. LND wallet not created)
- gray dashed: not installed or can't be checked

**Core sync without an RPC login:** compares Mempool's tip height and newest-block time and the Electrs index height,
plus an optional public tip (`https://mempool.space/api/blocks/tip/height`, cached 5 min; set `REFERENCE_TIP_URL=` empty to disable;
works offline). Shows "Syncing - catching up" (amber) when evidence says the chain is behind, "at chain tip (checked via Mempool)" when verified,
and amber "can't verify sync" when there is no evidence — never a false green.

Zero dependencies: Node.js 18.15+, `server.js` + `public/index.html`. MIT.

## Desktop top bar (v2.3)
On screens 1100 px and wider the header is a left-to-right bar: title and BTC price on the far left, node name, update time and quick stats (network tip, node height, sync %, index height, mempool tx, fees from your Mempool) in the middle, status pills on the right. Phone layout is unchanged.

## Run
    DEMO=1 node server.js            # fake data; pick scenario in the header or ?scenario=
                                     # healthy | syncing-no-rpc | syncing-rpc | electrs-down | mempool-down | lnd-waiting | cant-verify | knots
    node server.js                   # real probes, port 3880 (PORT to change)

## Env
| var | purpose |
|---|---|
| BITCOIN_RPC_USER / BITCOIN_RPC_PASS | enables height/headers/sync/peers/mempool/disk via getblockchaininfo, getnetworkinfo, getmempoolinfo. Never logged or sent to the browser. |
| BITCOIN_RPC_HOST / BITCOIN_RPC_PORT | override (default from config: Core 10.21.21.8:8332) |
| LND_READONLY_MACAROON_HEX | optional; adds synced/channels/peers from LND `/v1/getinfo`. Without it only `/v1/state` (no auth) is used. |
| APP_DATA_DIR | Umbrel app-data dir mounted read-only; an app counts as installed if `<dir>/<appId>` exists. Unset = installed means "answers on its port". |
| DATA_PATH | disk for the System panel (default /mnt/data) |
| UI_PROBE_HOST | host to TCP-probe UI-only apps (RTL, ThunderHub); unset = shown grey "no health probe" |
| HISTORY_FILE | 24h ring buffer (5-min buckets), default data/history.json |
| REFERENCE_TIP_URL | optional public tip height URL for sync detection (default mempool.space; empty = off) |
| PRICE_ENABLED | `1` (default) shows the BTC/USD price in the wide desktop top bar. **Makes an outbound request** (at most once per 60 s) to a public price API: your local Mempool `/api/v1/prices` first, then `https://mempool.space/api/v1/prices`, then `https://api.coinbase.com/v2/prices/BTC-USD/spot`. Set `0` to turn off (or `"price":{"enabled":false}` in config.json). Offline it shows "Price unavailable"; a price older than 30 min is never shown. |
| ALERT_WEBHOOK_URL | **off by default**. If set (or `alerts.enabled` in config.json), POSTs `{service,status,detail}` on each state change. |

Statuses: ok (green), warn (amber: syncing, >3 blocks behind node, no peers), waiting (blue: LND wallet not created/locked — normal, not an error), down (red), unknown (grey).
Read-only: HTTP server answers GET/HEAD only (405 otherwise); probes are TCP connects, GETs, the Electrum `blockchain.headers.subscribe` call and read-only RPC methods.
"Open UI" links use the page's own hostname + the app's Umbrel port, so they work via umbrel.local or the LAN IP.

## Ports / addresses
Verified 2026-10-27 against getumbrel/umbrel-apps `master` (`<app>/umbrel-app.yml` port, `<app>/exports.sh`, mempool `docker-compose.yml`). Not yet checked live on Node Master.

| app id | role | UI port | internal probe | source |
|---|---|---|---|---|
| bitcoin (Bitcoin Node 1.4.1) | node | 2100 | RPC 10.21.21.8:8332 (P2P 8333) | bitcoin/exports.sh APP_BITCOIN_NODE_IP, APP_BITCOIN_RPC_PORT |
| bitcoin-knots (1.2.13) | node alt | 2105 | RPC 10.21.21.7:9332 | bitcoin-knots/exports.sh |
| electrs (0.11.1) | indexer | 2102 | Electrum 10.21.21.10:50001 | electrs/exports.sh APP_ELECTRS_NODE_IP/PORT |
| fulcrum (2.1.4) | indexer alt | 2109 | Electrum 10.21.21.200:50002 | fulcrum/exports.sh |
| mempool (3.3.2) | explorer | 3006 | API 10.21.21.27:8999 `/api/v1/blocks/tip/height` | mempool/exports.sh APP_MEMPOOL_API_IP, docker-compose MEMPOOL_HTTP_PORT |
| lightning (LND 0.21.5) | lightning | 2101 | REST https 10.21.21.9:8080 (gRPC 10009, P2P 9735) | lightning/exports.sh |
| core-lightning (26.06.9) | lightning alt | 2103 | daemon 10.21.21.96:9736 (TCP only) | core-lightning/exports.sh |
| ride-the-lightning | LN UI | 3001 | none | umbrel-app.yml |
| thunderhub | LN UI alt | 3000 | none | umbrel-app.yml |

Unverified: ETBC Pool and Miner Controller (community store `minerops`, ports unknown, uiPort null); Electrum tip via
`blockchain.headers.subscribe` during Electrs initial indexing (may not answer until indexed — shown as "Indexing");
whether an app container can reach these 10.21.21.x IPs without joining the Umbrel network (Umbrel apps normally can);
LND `/v1/state` path is standard LND REST but not tested against this install; mounting `${UMBREL_ROOT}/app-data` read-only in a community app.

## Umbrel package
`umbrel-package/` is an **UNTESTED** skeleton (store yml + app folder with umbrel-app.yml, docker-compose.yml, exports.sh). `Dockerfile` builds the image; nothing is built or pushed.

## v2.4.0
- DATUM Gateway slot (Core → DATUM → Mining; app id `datum`, container `datum_datum_1`, stratum 23334, web UI 21000). Installed-but-unreachable shows gray, never red.
- Mining slot detects `fieldlab-etbc-pool` (stratum 3333, UI 8745) and `fieldlab-miner-controller` (UI 8742) by Umbrel app id and container hostname; green only when a TCP check answers.
- Electrs/Fulcrum with the Electrum port closed shows amber "Still building its index" (red only if its web UI is also closed, when `UI_PROBE_HOST` is set).
- Favicon: /favicon.ico, /favicon.svg, /favicon-32.png, /apple-touch-icon.png.
- "See other options" entries link to the app's store page.
- Tests: `npm test`. Demo scenarios add `electrs-indexing`, `datum-missing`.
