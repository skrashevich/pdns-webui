![telegram-cloud-photo-size-2-5255818602324103738-y](https://github.com/user-attachments/assets/57ad42bd-fc9f-48cf-8582-f523e89ac946)


# PowerDNS Web UI

A lightweight web interface for managing **PowerDNS Authoritative Server 4.6** via its built-in HTTP API.

## Features

- **Zone management** – list, create, edit, delete authoritative zones (Native / Master / Slave)
- **Record management** – full CRUD for DNS records (A, AAAA, CNAME, MX, NS, TXT, SOA, SRV, PTR, CAA)
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
| `PORT`           | `8080`                    | Port the UI listens on                     |

## Architecture

```
browser  ──fetch──►  Go HTTP server (main.go)  ──net/http──►  PowerDNS API (:8081)
                     serves static SPA                         /api/v1/servers/…
```

The Go backend acts as an authenticated proxy so the PowerDNS API key is never exposed to the browser.
