<img width="2007" height="1015" alt="image" src="https://github.com/user-attachments/assets/6c8e402d-9bcb-4d67-a610-0ee5e99b6447" />

<!-- badges:start -->
[![GitHub release](https://img.shields.io/github/v/release/skrashevich/pdns-webui?style=flat-square&label=release)](https://github.com/skrashevich/pdns-webui/releases)
[![GitHub stars](https://img.shields.io/github/stars/skrashevich/pdns-webui?style=flat-square)](https://github.com/skrashevich/pdns-webui/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/skrashevich/pdns-webui?style=flat-square)](https://github.com/skrashevich/pdns-webui/issues)
[![Last commit](https://img.shields.io/github/last-commit/skrashevich/pdns-webui?style=flat-square)](https://github.com/skrashevich/pdns-webui/commits/main)
[![Go version](https://img.shields.io/badge/Go-1.26-00ADD8?style=flat-square&logo=go)](https://go.dev)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/skrashevich/pdns-webui/blob/main/Dockerfile)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](https://github.com/skrashevich/pdns-webui)
[![Docs](https://img.shields.io/badge/docs-mintlify-2563EB?style=flat-square&logo=mintlify)](https://pdns-webui.mintlify.app)
<!-- badges:end -->



# PowerDNS Web UI

A lightweight web interface for managing **PowerDNS Authoritative Server 4.** via its built-in HTTP API.

## Security Warning

> [!WARNING]
> This web UI provides **no built-in authentication or authorization**.
> Access restriction is entirely the **user/operator's responsibility** (for example: firewall rules, private network/VPN, reverse proxy auth).

## Features

- **Zone management** – list, create, edit, delete authoritative zones (Native / Master / Slave)
- **Record management** – full CRUD for DNS records (A, AAAA, ALIAS, CNAME, MX, NS, TXT, SOA, SRV, PTR, CAA)
- **Multi-value records** – multiple A/AAAA/NS/… records for the same name/type
- **Notify slaves** – send `NOTIFY` to all slave servers with one click
- **Zone export** – view and copy the raw zone file
- **Connection status** – real-time check from the Settings page

## Prerequisites

PowerDNS must have the HTTP API enabled. Add to `pdns.conf`:

```ini
webserver=yes
webserver-port=8081
webserver-allow-from=127.0.0.1,::1   # adjust as needed
api=yes
api-key=yoursecretkey
```

## Quick Start

### Go (development)

```bash
cp .env.example .env
# edit .env – set PDNS_API_URL and PDNS_API_KEY
go run .
# or override listen address via CLI flags:
go run . -host 127.0.0.1 -port 8080
```

Open <http://localhost:8080>

### Docker Compose

```bash
cp .env.example .env
# edit .env
docker compose up -d
```

## Configuration

| Variable         | Default                   | Description                                |
|------------------|---------------------------|--------------------------------------------|
| `PDNS_API_URL`   | `http://localhost:8081`   | PowerDNS API base URL                      |
| `PDNS_API_KEY`   | `changeme`                | Must match `api-key` in pdns.conf          |
| `PDNS_SERVER_ID` | `localhost`               | PowerDNS server ID (almost always default) |
| `HOST`           | `0.0.0.0`                 | Host/interface the UI listens on           |
| `PORT`           | `8080`                    | Port the UI listens on           |

### ALIAS records

PowerDNS Authoritative serves `ALIAS` records only when alias expansion is configured. For PowerDNS 5.1, set a resolver that does not point back to the authoritative server itself and enable expansion in `pdns.conf`:

```ini
resolver=[::1]:5300
expand-alias=yes
```

`ALIAS` is intended for the zone apex (`@`) and uses one target name per RRset.

### CLI flags

- `-host` — host/interface to listen on (default from `HOST` env var)
- `-port` — port to listen on (default from `PORT` env var)
- `-h` — show help

## Architecture

```
browser  ──fetch──►  Go HTTP server (main.go)  ──net/http──►  PowerDNS API (:8081)
                     serves static SPA                         /api/v1/servers/…
```

The Go backend acts as an authenticated proxy so the PowerDNS API key is never exposed to the browser.

## Documentation

Full documentation is available at **📖 [pdns-webui docs](https://pdns-webui.mintlify.app)** — covers deployment, configuration, zone and record management, and troubleshooting.

The documentation source lives in [`docs/`](docs/) and is built with [Mintlify](https://mintlify.com/).