# FasFox Tunnel

Expose any number of local ports to public URLs through a FasFox server — no public IP, no domain, no router port-forwarding.

一个轻量的内网穿透客户端:把本地**任意多个端口**暴露成 FasFox 公网地址,无需公网 IP、域名或路由器端口映射。

## Features

- **Many ports, one process** — map several tunnels at once (`--map` repeatable, or a config file).
- **Secure by design** — a per-tunnel Ed25519 keypair; the **private key never leaves your machine**; every connection uses a one-time challenge-signature handshake.
- **Tiny** — a single dependency (`ws`), ~250 lines, Node ≥ 18.
- **Auto-reconnect** with exponential backoff.
- **Ships as a binary** — prebuilt executables for macOS / Linux / Windows, no Node required.

## Install

**npm**
```bash
npm install -g fasfox-tunnel
```

**Prebuilt binary** — grab the one for your OS from [Releases](https://github.com/NightPoetry/fasfox-tunnel/releases) (macOS arm64/x64, Linux x64, Windows x64). No Node needed.

**From source**
```bash
git clone https://github.com/NightPoetry/fasfox-tunnel && cd fasfox-tunnel
npm install && node src/index.js --help
```

## Usage

**One tunnel**
```bash
fasfox-tunnel --server wss://HOST/area/_agent --key sk-XXX \
              --tunnel <id> --local http://localhost:8080
```

**Many tunnels, one process**
```bash
fasfox-tunnel --server wss://HOST/area/_agent --key sk-XXX \
              --map <id1>=http://localhost:8090 \
              --map <id2>=http://localhost:3000
```

**Config file** (recommended for several tunnels)
```bash
fasfox-tunnel --config tunnels.json
```
`tunnels.json` (copy from `tunnels.example.json`):
```json
{
  "server": "wss://HOST/area/_agent",
  "key": "sk-XXX",
  "tunnels": [
    { "id": "TUNNEL_ID_1", "local": "http://localhost:8090" },
    { "id": "TUNNEL_ID_2", "local": "http://localhost:3000" }
  ]
}
```
Each tunnel may override `server`/`key` if you point different tunnels at different servers.

## How it works

The client generates an Ed25519 keypair locally (private key stored at `~/.fasfox-tunnel/<id>.pem`, mode `600`). It registers the public key using your API key, then for each connection fetches a one-time challenge, signs it, and opens an authenticated WebSocket. Public requests hitting `/area/<id>/*` are forwarded to your `--local` target and the response is streamed back.

## LAN tip (important)

If your FasFox server is reachable on your LAN, point `--server` at the **internal** address over plain `ws://` (e.g. `ws://192.168.x.x:PORT/area/_agent`). Some free public-tunnel providers don't pass WebSocket upgrades, so running the **control channel over the LAN** avoids `401` / reconnect loops — public HTTP visitors still reach you through the public host as usual.

Also: if you move the client to a new machine or change servers, delete the old key first (`rm ~/.fasfox-tunnel/<id>.pem`) so it re-registers cleanly — a stale key makes the client skip registration and the server reject the handshake.

## Security

- **Never commit your API key or private keys.** `tunnels.json` and `*.pem` are gitignored; use `tunnels.example.json` as a template with placeholders.
- Access mode (`public` / `token` / `signed`) is configured **on the server side** per tunnel. Private backends should use `token` or `signed` so strangers can't drive traffic through your tunnel.

## Build binaries

```bash
npm run build        # @yao-pkg/pkg → dist/ for macOS(arm64/x64) / Linux / Windows
```
Or push a git tag `vX.Y.Z` — the GitHub Actions workflow builds all platforms and attaches them to a Release.

## License

MIT © NightPoetry. See [LICENSE](./LICENSE).
