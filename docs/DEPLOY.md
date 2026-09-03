# Deploy Production — tapsite-db-mcp

Deploy mode **SSE** menggunakan **PM2** (process manager) + **Caddy** (reverse proxy + auto SSL). **Tanpa Docker.**

MCP client connect via URL `https://db.tapsite.ai/sse`.

---

## Prasyarat Server

- Linux server (Ubuntu/Debian) dengan akses `sudo`
- **Node.js 20+** terinstall
- **PM2** terinstall: `npm install -g pm2`
- **Caddy** terinstall: lihat [caddyserver.com/docs/install](https://caddyserver.com/docs/install)
- **PostgreSQL** tapsite accessible dari server (localhost atau remote)
- **DNS A record** `db.tapsite.ai` → IP server (untuk auto SSL Caddy)

---

## 1. Upload project ke server

```bash
# Di server
cd /home/admin/tapsite-mcp-db
npm install
npm run build
mkdir -p logs
```

> Jika project tapsite-new sudah ada di server, cukup `cd` ke `mcp/` subdirectory.

## 2. Set environment variables

Edit `ecosystem.config.cjs` — sesuaikan PG connection dan ganti `MCP_AUTH_TOKEN` dengan string random yang panjang:

```bash
# Generate random token
openssl rand -hex 32
```

```javascript
module.exports = {
  apps: [
    {
      name: "tapsite-db-mcp",
      script: "dist/index.js",
      cwd: "/home/admin/tapsite-mcp-db",
      env: {
        PGHOST: "127.0.0.1",
        PGPORT: "3309",
        PGUSER: "postgres",
        PGPASSWORD: "actual-password-here",
        PGDATABASE: "tapsite",
        MCP_PORT: "3100",
        MCP_DB_MAX_ROWS: "500",
        MCP_AUTH_TOKEN: "hasil-openssl-rand-hex-32-disini",
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
      out_file: "/home/admin/tapsite-mcp-db/logs/out.log",
      error_file: "/home/admin/tapsite-mcp-db/logs/error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
```

> `MCP_PORT=3100` mengaktifkan mode SSE. Tanpa ini server jalan mode stdio (tidak cocok untuk deploy).
>
> `MCP_AUTH_TOKEN` wajib di-set untuk production. Tanpa ini, endpoint SSE terbuka tanpa auth — siapa saja yang bisa reach port 3100 bisa query database.

## 3. Start dengan PM2

```bash
cd /home/admin/tapsite-mcp-db
pm2 start ecosystem.config.cjs
pm2 save
```

Verifikasi:

```bash
pm2 status
pm2 logs tapsite-db-mcp --lines 5
```

Output expected:

```
[tapsite-db-mcp] SSE server on port 3100 — db=127.0.0.1:3309/tapsite, max_rows=500, auth=enabled
```

### Auto-start saat reboot

```bash
pm2 startup
# Jalankan perintah yang di-output pm2 startup (sudo env PATH=...)
pm2 save
```

## 4. Konfigurasi Caddy

Append `Caddyfile` project ke Caddyfile utama server:

```bash
sudo cat /home/admin/tapsite-mcp-db/Caddyfile >> /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Atau manual edit `/etc/caddy/Caddyfile`, tambahkan block:

```caddyfile
db.tapsite.ai {
    reverse_proxy localhost:3100 {
        # SSE needs long-lived connections and no buffering
        flush_interval -1
        transport http {
            read_timeout 300s
            write_timeout 300s
        }
    }

    # CORS — allow MCP clients to connect from anywhere
    header {
        Access-Control-Allow-Origin "*"
        Access-Control-Allow-Methods "GET, POST, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization"
    }

    # Handle SSE preflight
    @options method OPTIONS
    handle @options {
        respond 204
    }
}
```

Caddy auto-provision SSL untuk `db.tapsite.ai` (pastikan DNS A record sudah pointing ke server).

## 5. Verifikasi

```bash
# Health check
curl https://db.tapsite.ai/health
# {"status":"ok","database":"127.0.0.1:3309/tapsite","max_rows":500}

# Test SSE endpoint (dengan token)
curl -N -H "Authorization: Bearer <token>" https://db.tapsite.ai/sse
```

Output expected:

```
event: endpoint
data: /messages?sessionId=xxx
```

Test dari MCP client — connect ke URL `https://db.tapsite.ai/sse` dengan header `Authorization: Bearer <token>`.

---

## MCP Client Config (SSE mode)

### omp — edit `.omp/mcp.json`

```json
{
  "mcpServers": {
    "tapsite-db": {
      "url": "https://db.tapsite.ai/sse",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

### Claude Desktop — edit `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tapsite-db": {
      "url": "https://db.tapsite.ai/sse",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

> Jika client tidak support custom headers, gunakan query param: `https://db.tapsite.ai/sse?api_key=<token>`

---

## Update / Restart

```bash
cd /home/admin/tapsite-mcp-db
git pull
npm install
npm run build
pm2 restart tapsite-db-mcp
```

## Operasi PM2 lainnya

```bash
pm2 status                        # lihat status semua proses
pm2 logs tapsite-db-mcp           # tail log (live)
pm2 logs tapsite-db-mcp --lines 50   # 50 baris terakhir
pm2 stop tapsite-db-mcp           # stop
pm2 restart tapsite-db-mcp        # restart
pm2 delete tapsite-db-mcp         # hapus dari pm2 (tidak hapus file)
pm2 monit                         # dashboard interaktif (CPU/mem/log)
```

## Troubleshooting

| Gejala | Cek |
|--------|-----|
| `pm2 status` process `errored` | `pm2 logs tapsite-db-mcp` — biasanya PG connection gagal (host/port/password salah) |
| `curl /sse` connection refused | PM2 tidak jalan atau port salah — cek `MCP_PORT` match dengan Caddyfile |
| `curl /sse` 502 Bad Gateway | Caddy tidak bisa reach `localhost:3100` — pastikan PM2 jalan |
| `curl /sse` 401 Unauthorized | `MCP_AUTH_TOKEN` tidak match — cek token di client vs `ecosystem.config.cjs` |
| SSL tidak ter-provision | DNS A record `db.tapsite.ai` belum pointing — cek `dig db.tapsite.ai` |
| Query error `ECONNREFUSED` | PostgreSQL tidak reachable — cek `PGHOST`, `PGPORT`, dan apakah PG jalan |
| Query error `password authentication failed` | `PGUSER` / `PGPASSWORD` salah |
| Query error `database "tapsite" does not exist` | `PGDATABASE` salah |
| Query error `cannot execute ... within a read-only transaction` | Expected untuk write attempts. Jika muncul saat SELECT, pastikan tidak ada function call yang melakukan write internally |
