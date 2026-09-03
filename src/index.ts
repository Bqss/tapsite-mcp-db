import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import pg from "pg";
import { z } from "zod";

const { Client } = pg;

// ─── Config ────────────────────────────────────────────────────────

const PG_CONFIG = {
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "",
  database: process.env.PGDATABASE || "tapsite",
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
};

const MAX_ROWS = Number(process.env.MCP_DB_MAX_ROWS || 500);
const MCP_PORT = parseInt(process.env.MCP_PORT || "0");
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

// ─── Database ──────────────────────────────────────────────────────

/**
 * Open a fresh readonly connection per request.
 * We use a short-lived Client (not a pool) because:
 * 1. MCP tool calls are infrequent — no need for connection reuse.
 * 2. Each connection is opened with a read-only transaction, guaranteeing
 *    the session cannot write even if a bypass slips through validation.
 */
async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client(PG_CONFIG);
  await client.connect();
  try {
    // Hard safety: force the session to read-only. Any INSERT/UPDATE/DELETE/etc.
    // will raise "cannot execute ... within a read-only transaction".
    await client.query("BEGIN READ ONLY");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

// ─── Safety: validate that a SQL string is a readonly SELECT ───────

/**
 * Reject anything that is not a single SELECT statement (or WITH ... SELECT).
 * Blocks INSERT/UPDATE/DELETE/etc. and multi-statement injection.
 * This is a defense-in-depth layer on top of BEGIN READ ONLY — even if
 * validation has a gap, PostgreSQL itself will reject writes.
 */
function assertReadonlySelect(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, "").trim();

  if (!trimmed) {
    throw new Error("Empty SQL statement.");
  }

  // No semicolons allowed in the body (prevents multi-statement injection).
  if (trimmed.includes(";")) {
    throw new Error("Multiple statements are not allowed. Provide a single SELECT query.");
  }

  const upper = trimmed.toUpperCase();

  if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
    throw new Error(
      "Only SELECT (or WITH ... SELECT) statements are allowed. " +
        "The query must start with SELECT or WITH.",
    );
  }

  const forbidden = [
    /\bINSERT\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bDROP\b/i,
    /\bALTER\b/i,
    /\bCREATE\b/i,
    /\bTRUNCATE\b/i,
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bCOPY\b/i,
    /\bVACUUM\b/i,
    /\bREINDEX\b/i,
    /\bREPLACE\b/i,
    /\bMERGE\b/i,
    /\bTRIGGER\b/i,
    /\bTRANSACTION\b/i,
    /\bCOMMIT\b/i,
    /\bROLLBACK\b/i,
    /\bSAVEPOINT\b/i,
    /\bLOAD\b/i,
    /\bCALL\b/i,
    /\bDO\b/i,
    /\bEXECUTE\b/i,
    /\bPREPARE\b/i,
    /\bDEALLOCATE\b/i,
    /\bLISTEN\b/i,
    /\bNOTIFY\b/i,
  ];

  for (const re of forbidden) {
    if (re.test(trimmed)) {
      throw new Error(`Forbidden keyword detected in query: ${re.source.replace(/\\b/g, "")}.`);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function truncateRows(rows: unknown[]): { rows: unknown[]; truncated: boolean; totalShown: number } {
  if (rows.length > MAX_ROWS) {
    return { rows: rows.slice(0, MAX_ROWS), truncated: true, totalShown: MAX_ROWS };
  }
  return { rows, truncated: false, totalShown: rows.length };
}

function formatResult(rows: unknown[], truncated: boolean, totalShown: number): string {
  const meta = truncated
    ? `\n\n[Truncated: showing ${totalShown} of more rows. Refine your query or raise MCP_DB_MAX_ROWS (currently ${MAX_ROWS}).]`
    : `\n\n[${totalShown} row(s)]`;
  return JSON.stringify(rows, null, 2) + meta;
}

// ─── Server ────────────────────────────────────────────────────────

/**
 * Create a fresh McpServer instance with all tools registered.
 * Each SSE connection gets its own instance — the SDK does not allow
 * reusing a single McpServer across multiple transports.
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: "tapsite-db",
    version: "1.0.0",
  });

// ── list_tables ───────────────────────────────────────────────────

server.tool(
  "list_tables",
  "List all tables in the tapsite PostgreSQL database (public schema). Returns table names and estimated row counts. No parameters needed.",
  {},
  async () => {
    const result = await withDb(async (client) => {
      const tables = await client.query(
        `SELECT tablename
         FROM pg_tables
         WHERE schemaname = 'public'
         ORDER BY tablename`,
      );

      const result = [];
      for (const t of tables.rows) {
        try {
          const count = await client.query(`SELECT count(*) AS c FROM "${t.tablename}"`);
          result.push({ table: t.tablename, rows: Number(count.rows[0].c) });
        } catch {
          result.push({ table: t.tablename, rows: -1 });
        }
      }
      return result;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2) + `\n\n[${result.length} table(s)]`,
        },
      ],
    };
  },
);

// ── describe_table ────────────────────────────────────────────────

server.tool(
  "describe_table",
  "Show the schema (columns, types, constraints) and indexes of a specific table. Use this before querying a table you're unfamiliar with.",
  {
    table: z.string().describe("Name of the table to describe"),
  },
  async (params) => {
    const schema = await withDb(async (client) => {
      // Validate table exists
      const exists = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
        [params.table],
      );

      if (exists.rows.length === 0) {
        return null;
      }

      const columns = await client.query(
        `SELECT
           c.column_name,
           c.data_type,
           c.is_nullable,
           c.column_default,
           c.character_maximum_length,
           c.numeric_precision,
           c.numeric_scale
         FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = $1
         ORDER BY c.ordinal_position`,
        [params.table],
      );

      // Primary key columns
      const pk = await client.query(
        `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary
         ORDER BY array_position(i.indkey, a.attnum)`,
        [`public.${params.table}`],
      );

      const pkColumns = pk.rows.map((r: { attname: string }) => r.attname);

      // Indexes
      const indexes = await client.query(
        `SELECT
           i.relname AS index_name,
           idx.indisunique AS is_unique,
           idx.indisprimary AS is_primary,
           array_agg(a.attname ORDER BY array_position(idx.indkey, a.attnum)) AS columns
         FROM pg_index idx
         JOIN pg_class c ON c.oid = idx.indrelid
         JOIN pg_class i ON i.oid = idx.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(idx.indkey)
         WHERE n.nspname = 'public' AND c.relname = $1
         GROUP BY i.relname, idx.indisunique, idx.indisprimary
         ORDER BY i.relname`,
        [params.table],
      );

      // Foreign keys
      const fks = await client.query(
        `SELECT
           con.conname AS constraint_name,
           a.attname AS column_name,
           rel.relname AS foreign_table,
           af.attname AS foreign_column
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_class rel ON rel.oid = con.confrelid
         JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = con.conkey[1]
         JOIN pg_attribute af ON af.attrelid = rel.oid AND af.attnum = con.confkey[1]
         WHERE n.nspname = 'public' AND cl.relname = $1 AND con.contype = 'f'
         ORDER BY con.conname`,
        [params.table],
      );

      return {
        table: params.table,
        columns: columns.rows.map((c: Record<string, unknown>) => ({
          name: c.column_name,
          type: c.data_type,
          not_null: c.is_nullable === "NO",
          default: c.column_default,
          max_length: c.character_maximum_length ?? null,
          primary_key: pkColumns.includes(c.column_name as string),
        })),
        indexes: indexes.rows.map((i: Record<string, unknown>) => ({
          name: i.index_name,
          unique: i.is_unique,
          primary: i.is_primary,
          columns: i.columns,
        })),
        foreign_keys: fks.rows.map((f: Record<string, unknown>) => ({
          constraint: f.constraint_name,
          column: f.column_name,
          references_table: f.foreign_table,
          references_column: f.foreign_column,
        })),
      };
    });

    if (!schema) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Table "${params.table}" does not exist in schema "public". Use list_tables to see available tables.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(schema, null, 2),
        },
      ],
    };
  },
);

// ── query ─────────────────────────────────────────────────────────

server.tool(
  "query",
  "Run a readonly SELECT query against the tapsite PostgreSQL database. Only SELECT (or WITH ... SELECT) statements are allowed. Results are capped at MCP_DB_MAX_ROWS (default 500) rows. Use list_tables to discover tables and describe_table to understand their schema.",
  {
    sql: z.string().describe("A single SELECT or WITH ... SELECT statement. No semicolons needed."),
  },
  async (params) => {
    try {
      assertReadonlySelect(params.sql);
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Query rejected: ${(e as Error).message}` }],
        isError: true,
      };
    }

    try {
      const rows = await withDb(async (client) => {
        const result = await client.query(params.sql);
        return result.rows;
      });

      const { rows: shown, truncated, totalShown } = truncateRows(rows);
      return {
        content: [
          {
            type: "text" as const,
            text: formatResult(shown, truncated, totalShown),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Query error: ${(e as Error).message}\n\nSQL: ${params.sql}`,
          },
        ],
        isError: true,
      };
    }
  },
);

  return server;
}

// ─── Auth (SSE mode) ───────────────────────────────────────────────

function extractToken(req: express.Request): string | null {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string") {
    return apiKeyHeader;
  }
  const apiKeyQuery = req.query["api_key"];
  if (typeof apiKeyQuery === "string") {
    return apiKeyQuery;
  }
  return null;
}

function checkAuth(req: express.Request): boolean {
  if (!AUTH_TOKEN) return true;
  const token = extractToken(req);
  return token === AUTH_TOKEN;
}

// ─── Start ─────────────────────────────────────────────────────────

async function main() {
  // Touch the DB early so we fail fast if connection is wrong.
  await withDb(async (client) => {
    await client.query("SELECT 1");
  });

  if (MCP_PORT > 0) {
    const app = express();
    app.use(express.json());

    const sessions = new Map<string, SSEServerTransport>();

    app.get("/sse", async (req, res) => {
      if (!checkAuth(req)) {
        res.status(401).json({
          error: "Unauthorized. Provide Authorization: Bearer <token> or ?api_key=<token>.",
        });
        return;
      }

      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);
      res.on("close", () => sessions.delete(transport.sessionId));
      await createServer().connect(transport);
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await session.handlePostMessage(req, res, JSON.stringify(req.body));
    });

    app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        database: `${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}`,
        max_rows: MAX_ROWS,
      });
    });

    app.listen(MCP_PORT, () => {
      console.log(
        `[tapsite-db-mcp] SSE server on port ${MCP_PORT} — db=${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}, max_rows=${MAX_ROWS}, auth=${AUTH_TOKEN ? "enabled" : "disabled"}`,
      );
    });
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
    console.error(
      `[tapsite-db-mcp] stdio connected — db=${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}, max_rows=${MAX_ROWS}`,
    );
  }
}

main().catch((err) => {
  console.error("[tapsite-db-mcp] fatal:", err);
  process.exit(1);
});
