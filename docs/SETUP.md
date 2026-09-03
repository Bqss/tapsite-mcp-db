# Setup — tapsite-db-mcp (Client)

MCP (Model Context Protocol) server untuk **readonly query** ke database PostgreSQL tapsite. Server sudah deploy di `https://db.tapsite.ai/sse` — client cukup connect via URL + token.

---

## Server

| Field | Value |
|-------|-------|
| URL | `https://db.tapsite.ai/sse` |
| Auth | `Authorization: Bearer <token>` |
| Fallback auth | `?api_key=<token>` (jika client tidak support custom headers) |

> Token didapat dari admin. Untuk deploy/maintenance server, lihat [DEPLOY.md](./DEPLOY.md).

---

## Connect MCP Client

### omp — edit `~/.omp/agent/mcp.json`

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

Setelah edit config, restart MCP client. Tool `list_tables`, `describe_table`, `query` akan muncul.

---

## Tools

### `list_tables`

Daftar semua tabel di schema `public` + row count. Tanpa parameter.

### `describe_table`

Schema lengkap sebuah tabel: kolom, type, nullable, default, primary key, index, foreign key.

Parameter: `table` (string) — nama tabel.

### `query`

Jalankan `SELECT` bebas ke database. Hanya menerima `SELECT` atau `WITH ... SELECT`. Hasil di-cap di 500 rows.

Parameter: `sql` (string) — single SELECT statement.

**Yang diblok:**
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY`, `VACUUM`, `REINDEX`, `REPLACE`, `MERGE`, `TRIGGER`, `TRANSACTION`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `LOAD`, `CALL`, `DO`, `EXECUTE`, `PREPARE`, `DEALLOCATE`, `LISTEN`, `NOTIFY`
- Multi-statement (semicolon di tengah)
- Statement tidak dimulai dengan `SELECT` atau `WITH`

---

## Safety Layer

Akses readonly di-enforce 3 lapis:

1. **PostgreSQL level** — setiap query dijalankan dalam `BEGIN READ ONLY` transaction. INSERT/UPDATE/DELETE/dll akan ditolak oleh PG sendiri: `"cannot execute ... within a read-only transaction"`
2. **SQL validation** — `assertReadonlySelect()` cek statement harus mulai dengan `SELECT`/`WITH`, no semicolons, no forbidden keywords
3. **Connection per request** — setiap tool call buka koneksi baru, jalankan query, lalu tutup. Tidak ada state persistent yang bisa bocor

---

## Architecture

```
┌──────────────┐   SSE (HTTPS)    ┌──────────────────┐   readonly    ┌────────────────────┐
│  MCP Client  │ ◄──────────────► │  tapsite-db-mcp  │ ────────────► │  PostgreSQL        │
│  (omp/Claude)│   Bearer token   │   (Node.js)      │               │  (tapsite database)│
└──────────────┘                  └──────────────────┘               └────────────────────┘
                                         │
                                         ├─ list_tables    → SELECT pg_tables + count(*)
                                         ├─ describe_table → information_schema + pg_index
                                         └─ query          → SELECT (validated, BEGIN READ ONLY)
```

---

## Local Development

Untuk run MCP server secara local (stdio mode), bukan connect ke server:

### Prasyarat

- **Node.js 20.6+** — cek dengan `node -v` (butuh `--env-file` support)
- **PostgreSQL** tapsite accessible di localhost

### 1. Install & build

```bash
cd tapsite-mcp-db
npm install
npm run build
```

### 2. Setup `.env`

```bash
cp .env.example .env
# Edit .env — sesuaikan PGPASSWORD dengan password postgres kamu
```

### 3. Test jalankan

```bash
npm run dev
```

Output expected:

```
[tapsite-db-mcp] stdio connected — db=127.0.0.1:3309/tapsite, max_rows=500
```

> `.env` sudah di-gitignore, tidak akan ter-commit.

### 4. Daftarkan ke MCP client (stdio mode)

#### omp — edit `~/.omp/agent/mcp.json`

```json
{
  "mcpServers": {
    "tapsite-db": {
      "command": "node",
      "args": [
        "--env-file=.env",
        "/path/to/tapsite-mcp-db/dist/index.js"
      ],
      "cwd": "/path/to/tapsite-mcp-db"
    }
  }
}
```

> `cwd` wajib di-set agar `--env-file=.env` resolve ke `.env` di project dir.

#### Claude Desktop — edit `~/Library/Application Support/Claude/claude_desktop_config.json`

Claude Desktop tidak support `cwd`, jadi env vars di-inline:

```json
{
  "mcpServers": {
    "tapsite-db": {
      "command": "node",
      "args": ["/path/to/tapsite-mcp-db/dist/index.js"],
      "env": {
        "PGHOST": "127.0.0.1",
        "PGPORT": "3309",
        "PGUSER": "postgres",
        "PGPASSWORD": "your-password",
        "PGDATABASE": "tapsite"
      }
    }
  }
}
```

### Quick test SSE mode di local

Uncomment `MCP_PORT` dan `MCP_AUTH_TOKEN` di `.env`:

```bash
npm start
```

Test dari terminal lain:

```bash
# Health check
curl http://localhost:3100/health
# {"status":"ok","database":"127.0.0.1:3309/tapsite","max_rows":500}

# Valid token → SSE connect
curl -N -H "Authorization: Bearer my-secret" http://localhost:3100/sse
# event: endpoint
# data: /messages?sessionId=xxx

# Invalid/missing token → 401
curl -N http://localhost:3100/sse
# {"error":"Unauthorized. Provide Authorization: Bearer <token> or ?api_key=<token>."}
```

---

## Environment Variables

Hanya relevan untuk local dev / server deploy. Client yang connect via SSE tidak perlu set ini.

| Variable | Required | Default | Keterangan |
|----------|----------|---------|-------------|
| `PGHOST` | ya | `127.0.0.1` | PostgreSQL host |
| `PGPORT` | ya | `5432` | PostgreSQL port |
| `PGUSER` | ya | `postgres` | PostgreSQL user |
| `PGPASSWORD` | ya | — | PostgreSQL password |
| `PGDATABASE` | ya | `tapsite` | Nama database |
| `PGSSL` | tidak | — | Set `true` jika PG requires SSL |
| `MCP_DB_MAX_ROWS` | tidak | `500` | Max rows per query result. Sisa row di-truncate |
| `MCP_PORT` | tidak | — | Port SSE server. Kosong = stdio mode, di-set (e.g. `3100`) = SSE mode |
| `MCP_AUTH_TOKEN` | tidak | — | Shared secret untuk SSE auth. Kosong = auth disabled. **Wajib di-set untuk production** |

> Local dev: set di `.env` (lihat `.env.example`). Production: set di `ecosystem.config.cjs` (lihat [DEPLOY.md](./DEPLOY.md)).
