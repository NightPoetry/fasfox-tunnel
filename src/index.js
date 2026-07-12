#!/usr/bin/env node
// FasFox Tunnel — a tiny, dependency-light reverse tunnel client.
// Expose any number of local ports to public URLs through a FasFox server,
// with no public IP and no domain of your own.
//
//   fasfox-tunnel --server wss://HOST/area/_agent --key sk-XXX --map <id>=http://localhost:8090
//   fasfox-tunnel --config tunnels.json          # many tunnels at once
//
// Per-tunnel Ed25519 keypair is generated locally; the private key never leaves the machine.
// MIT licensed. See README for details.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const VERSION = '1.0.0';

// ── argument parsing ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { map: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--map') { a.map.push(argv[++i]); continue; }
    if (k === '-h' || k === '--help') { a.help = true; continue; }
    if (k === '-v' || k === '--version') { a.version = true; continue; }
    if (k.startsWith('--')) { a[k.slice(2)] = argv[++i]; }
  }
  return a;
}

const USAGE = `FasFox Tunnel v${VERSION}

Expose local ports to public URLs through a FasFox server.

Single tunnel:
  fasfox-tunnel --server wss://HOST/area/_agent --key sk-XXX \\
                --tunnel <id> --local http://localhost:8080

Many tunnels (one process):
  fasfox-tunnel --server wss://HOST/area/_agent --key sk-XXX \\
                --map <id1>=http://localhost:8090 \\
                --map <id2>=http://localhost:3000

From a config file:
  fasfox-tunnel --config tunnels.json

Options:
  --server <url>     FasFox agent endpoint (wss://HOST/area/_agent). For LAN use ws://.
  --key <sk-...>     Your FasFox API key (registers the client public key).
  --tunnel <id>      A single tunnel id (use with --local).
  --local <url>      Local target for --tunnel (default http://localhost:8080).
  --map <id>=<url>   Map a tunnel id to a local target. Repeatable for many tunnels.
  --config <file>    JSON config with { server, key, tunnels: [{ id, local }] }.
  --keydir <dir>     Where to store private keys (default ~/.fasfox-tunnel).
  -v, --version      Print version.
  -h, --help         Print this help.

The config file may set a top-level server/key and override them per tunnel.
`;

// ── build the list of tunnels to run, from config file or CLI ───────────────
function loadTunnels(args) {
  let server, key, keydir = args.keydir, list = [];

  if (args.config) {
    const cfg = JSON.parse(fs.readFileSync(args.config, 'utf8'));
    server = cfg.server; key = cfg.key; keydir = keydir || cfg.keydir;
    for (const t of cfg.tunnels || []) {
      const id = t.id || t.tunnel;
      if (!id || !t.local) throw new Error('config: each tunnel needs { id, local }');
      list.push({ server: t.server || server, key: t.key || key, id, local: t.local });
    }
  } else {
    server = args.server; key = args.key;
    if (args.tunnel) list.push({ server, key, id: args.tunnel, local: args.local || 'http://localhost:8080' });
    for (const m of args.map) {
      const eq = m.indexOf('=');
      if (eq < 0) throw new Error(`--map expects <id>=<localUrl>, got "${m}"`);
      list.push({ server, key, id: m.slice(0, eq), local: m.slice(eq + 1) });
    }
  }

  keydir = keydir || path.join(os.homedir(), '.fasfox-tunnel');
  if (!list.length) throw new Error('no tunnels: give --tunnel/--local, one or more --map, or --config');
  for (const t of list) {
    if (!t.server || !t.key) throw new Error(`tunnel ${t.id}: missing server or key`);
    t.local = String(t.local).replace(/\/+$/, '');
    t.keyfile = path.join(keydir, `${t.id}.pem`);
  }
  return list;
}

// ── one tunnel = one WS connection + local forwarding + auto-reconnect ───────
class Tunnel {
  constructor(cfg) {
    Object.assign(this, cfg);
    this.httpBase = this.server.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/area\/_agent.*$/, '');
    this.backoff = 1000;
    this.maxBackoff = 30000;
    this.tag = `[${this.id}]`;
  }

  loadOrCreateKey() {
    if (fs.existsSync(this.keyfile)) {
      return { privateKey: crypto.createPrivateKey(fs.readFileSync(this.keyfile, 'utf8')), fresh: false };
    }
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(this.keyfile), { recursive: true });
    fs.writeFileSync(this.keyfile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    return { privateKey, fresh: true };
  }

  async registerPublicKey() {
    const pubPem = crypto.createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' });
    const res = await fetch(`${this.httpBase}/api/area/tunnels/${this.id}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.key },
      body: JSON.stringify({ publicKey: pubPem, label: os.hostname() }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.success === false) throw new Error(d.error || `register public key failed (${res.status})`);
    console.log(this.tag, 'public key registered');
  }

  async handleRequest(ws, msg) {
    const headers = {};
    for (const [k, v] of Object.entries(msg.headers || {})) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue;
      headers[k] = v;
    }
    try {
      const init = { method: msg.method, headers };
      if (msg.method !== 'GET' && msg.method !== 'HEAD' && msg.body) init.body = Buffer.from(msg.body, 'base64');
      const resp = await fetch(this.local + msg.path, init);
      const buf = Buffer.from(await resp.arrayBuffer());
      const respHeaders = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      ws.send(JSON.stringify({ t: 'res', id: msg.id, status: resp.status, headers: respHeaders, body: buf.toString('base64') }));
    } catch (e) {
      ws.send(JSON.stringify({ t: 'err', id: msg.id, message: 'local service unreachable: ' + e.message }));
    }
  }

  async connect() {
    let nonce;
    try {
      const r = await fetch(`${this.httpBase}/area/_challenge`);
      nonce = (await r.json()).nonce;
      if (!nonce) throw new Error('no challenge');
    } catch (e) {
      console.error(this.tag, 'challenge failed:', e.message, `— retry in ${Math.round(this.backoff / 1000)}s`);
      return this.retry();
    }
    const signature = crypto.sign(null, Buffer.from(nonce + this.id), this.privateKey).toString('base64');
    const url = `${this.server}?tunnelId=${encodeURIComponent(this.id)}&nonce=${encodeURIComponent(nonce)}&signature=${encodeURIComponent(signature)}`;
    const ws = new WebSocket(url);
    ws.on('open', () => { this.backoff = 1000; });
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === 'ready') console.log(this.tag, `online → ${msg.publicUrl}/  (forwarding to ${this.local})`);
      else if (msg.t === 'req') this.handleRequest(ws, msg);
    });
    ws.on('close', (code) => { console.error(this.tag, `closed (code ${code}), reconnecting in ${Math.round(this.backoff / 1000)}s`); this.retry(); });
    ws.on('error', (e) => console.error(this.tag, 'WS error:', e.message));
  }

  retry() { setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 2, this.maxBackoff); }

  async start() {
    const { privateKey, fresh } = this.loadOrCreateKey();
    this.privateKey = privateKey;
    if (fresh) await this.registerPublicKey();   // only a brand-new key needs registering
    console.log(this.tag, `starting · local ${this.local}`);
    this.connect();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) { console.log(VERSION); return; }
  if (args.help) { console.log(USAGE); return; }
  let tunnels;
  try { tunnels = loadTunnels(args); }
  catch (e) { console.error('error:', e.message, '\n\n' + USAGE); process.exit(1); }

  console.log(`FasFox Tunnel v${VERSION} · ${tunnels.length} tunnel(s)`);
  for (const cfg of tunnels) {
    const t = new Tunnel(cfg);
    try { await t.start(); }
    catch (e) { console.error(t.tag, 'failed to start:', e.message); }
  }
})();
