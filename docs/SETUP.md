# Setup — tapsite-db-mcp

MCP (Model Context Protocol) server untuk **readonly query** ke database PostgreSQL tapsite. Memungkinkan AI agent menjalankan `SELECT` bebas ke database tanpa akses write.

MCP support **dua mode transport**:
- **stdio** — local, di-spawn langsung oleh MCP client (omp, Claude Desktop, dll)
- **SSE/HTTP** — di-deploy di server sebagai service, client connect via URL

---

## Prasyarat

- **Node.js 20.6+** — cek dengan `node -v` (butuh `--env-file` support)
- **PostgreSQL** tapsite accessible (local atau remote)
- Env PG connection: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- Untuk mode SSE: **PM2**, **Caddy** (lihat [DEPLOY.md](./DEPLOY.md))

---

## Langkah Setup (Local — stdio mode)

### 1. Install dependencies

```bash
cd tapsite-mcp-db
npm install
```

### 2. Build

```bash
npm run build
```

Output compiled JS ada di `dist/` (gitignored).

### 3. Setup `.env` dan test jalankan

Salin `.env.example` dan edit password-nya:

```bash
cp .env.example .env
# Edit .env — sesuaikan PGPASSWORD dengan password postgres kamu
```
`npm run dev` sudah menggunakan `--env-file=.env` (Node 20.6+ native), jadi env vars ter-load otomatis:

```bash
npm run dev
```

Output expected:

```
[tapsite-db-mcp] stdio connected — db=127.0.0.1:3309/tapsite, max_rows=500
```

> Mode stdio tidak butuh `MCP_PORT`. Server langsung baca stdin/stdout untuk komunikasi MCP.
> `.env` sudah di-gitignore, tidak akan ter-commit.

### 4. Daftarkan ke MCP client

#### omp — edit `~/.omp/agent/mcp.json`

Menggunakan `--env-file=.env` + `cwd` agar env vars ter-load dari `.env`:

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

Claude Desktop tidak support `cwd`, jadi env vars di-inline di config:

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

Setelah edit config, restart MCP client. Tool `list_tables`, `describe_table`, `query` akan muncul.

---

## Langkah Setup (Server — SSE mode)

Untuk deploy di VPS sebagai service persistent, lihat [DEPLOY.md](./DEPLOY.md).

Quick test SSE mode di local — uncomment `MCP_PORT` dan `MCP_AUTH_TOKEN` di `.env`:

```bash
# Edit .env, uncomment:
# MCP_PORT=3100
# MCP_AUTH_TOKEN=my-secret

npm start
```

`npm start` juga menggunakan `--env-file=.env`, jadi `MCP_PORT` dan `MCP_AUTH_TOKEN` ter-load otomatis.

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

Salin `.env.example` sebagai template:

```bash
cp .env.example .env
```

> Untuk production, env di-set di `ecosystem.config.cjs` (baca [DEPLOY.md](./DEPLOY.md)), bukan `.env`.

---

## Tools

### `list_tables`

Daftar semua tabel di schema `public` + row count. Tanpa parameter.

### `describe_table`

Schema lengkap sebuah tabel: kolom, type, nullable, default, primary key, index, foreign key.

Parameter: `table` (string) — nama tabel.

### `query`

Jalankan `SELECT` bebas ke database. Hanya menerima `SELECT` atau `WITH ... SELECT`. Hasil di-cap di `MCP_DB_MAX_ROWS` rows.

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
┌──────────────┐   stdio / SSE   ┌──────────────────┐   readonly    ┌────────────────────┐
│  MCP Client  │ ◄─────────────► │  tapsite-db-mcp  │ ────────────► │  PostgreSQL        │
│  (omp/Claude)│                 │   (Node.js)      │               │  (tapsite database)│
└──────────────┘                 └──────────────────┘               └────────────────────┘
                                        │
                                        ├─ list_tables    → SELECT pg_tables + count(*)
                                        ├─ describe_table → information_schema + pg_index
                                        └─ query          → SELECT (validated, BEGIN READ ONLY)
```

---

## Files

tapsite-mcp-db/
├── src/
│   └── index.ts              — MCP server (tools + stdio/SSE transport)
├── dist/                     — Compiled JS (gitignored)
├── ecosystem.config.cjs      — PM2 config (production SSE mode)
├── Caddyfile                 — Caddy reverse proxy snippet
├── .env.example              — Environment variable template
├── .env                      — Local env (gitignored, dibuat dari .env.example)
├── package.json
├── tsconfig.json
└── .gitignore
```
