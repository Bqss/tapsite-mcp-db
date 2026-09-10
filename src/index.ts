import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import pg from "pg";
import { readFileSync } from "fs";
import { extname, basename } from "path";
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

// ─── Tapsite API (HTTP — for workspace management tools) ──────────

const TAPSITE_BASE_URL = process.env.TAPSITE_BASE_URL || "http://localhost:5555";
const TAPSITE_API_KEY = process.env.TAPSITE_API_KEY || "";

// ─── Pexels API (for image search) ────────────────────────────────

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";

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

// ─── HTTP helper (for workspace management tools) ──────────────────

interface HttpResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

async function makeHttpRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  extraFetchOptions?: RequestInit,
): Promise<HttpResult> {
  const url = `${TAPSITE_BASE_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TAPSITE_API_KEY) {
    headers["Authorization"] = `Bearer ${TAPSITE_API_KEY}`;
  }

  try {
    const options: RequestInit = { method, headers, ...extraFetchOptions };
    if (body && method !== "GET" && method !== "DELETE") {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    const text = await res.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    // Handle redirects (e.g. POST /workspaces returns 302)
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location") || "";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ redirect: true, status: res.status, location, body: parsed }, null, 2),
          },
        ],
      };
    }

    if (!res.ok) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: true, status: res.status, statusText: res.statusText, body: parsed }, null, 2),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Request failed: ${message}` }], isError: true };
  }
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

// ── Workspace Management (HTTP — Tapsite API) ────────────────────

server.tool(
  "create_workspace",
  "Create a new workspace. The domain parameter is a subdomain slug (e.g. 'mybrand') — the server appends '.tapsite.ai' automatically. Returns the workspace ID and full domain. Requires an active subscription or sufficient token credit for non-subscribers beyond the free tier limit.",
  {
    name: z.string().describe("Workspace name"),
    domain: z.string().describe("Subdomain slug (e.g. 'mybrand' — becomes 'mybrand.tapsite.ai'). Lowercase alphanumeric with hyphens only."),
    industry: z.string().optional().describe("Industry / business category (e.g. 'Teknologi', 'E-Commerce')"),
  },
  async (params) => {
    return makeHttpRequest("POST", "/workspaces", params, { redirect: "manual" });
  },
);

server.tool(
  "check_subdomain",
  "Check if a subdomain is available for workspace creation. Pass the subdomain slug (e.g. 'mybrand') — the tool appends '.tapsite.ai' automatically. Returns { exists: boolean }.",
  {
    subdomain: z.string().describe("Subdomain slug to check (e.g. 'mybrand' — checked as 'mybrand.tapsite.ai')"),
  },
  async (params) => {
    const fullDomain = `${params.subdomain}.tapsite.ai`;
    return makeHttpRequest("GET", `/api/check-subdomain?subdomain=${encodeURIComponent(fullDomain)}`);
  },
);

server.tool(
  "update_workspace_domain",
  "Update the domain of a workspace. For custom domains (e.g. 'example.com'), the user must have a Pro subscription and the domain must be configured via Cloudflare (A record to 185.227.135.88 or CNAME to cname.id.tapsite.ai with orange-cloud proxy enabled) before calling this. Can also switch back to a tapsite.ai subdomain. Returns success message.",
  {
    workspace_id: z.string().describe("UUID of the workspace"),
    domain: z.string().describe("New domain (e.g. 'customdomain.com' for custom domain, or 'newsub.tapsite.ai' for subdomain)"),
  },
  async (params) => {
    return makeHttpRequest("PUT", `/workspaces/${params.workspace_id}/domain`, { domain: params.domain });
  },
);

// ── Blog Management (HTTP — Tapsite API) ──────────────────────────

server.tool(
  "list_blogs",
  "List blog posts in a workspace with pagination, search, and status filter. Returns blogs array, pagination info, and status_counts.",
  {
    workspace_id: z.string().describe("UUID of the workspace"),
    page: z.number().optional().describe("Page number (default: 1)"),
    limit: z.number().optional().describe("Posts per page (default: 10)"),
    search: z.string().optional().describe("Search in title, excerpt, content, author (LIKE)"),
    status: z.string().optional().describe("Filter: published | draft | scheduled"),
  },
  async (params) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set("page", String(params.page));
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.search) qs.set("search", params.search);
    if (params.status) qs.set("status", params.status);
    const s = qs.toString();
    return makeHttpRequest("GET", `/api/workspaces/${params.workspace_id}/blogs${s ? `?${s}` : ""}`);
  },
);

server.tool(
  "create_blog_post",
  "Create a blog post in a workspace. Slug is auto-generated from title (slugify). If slug already exists in the same workspace, a random suffix is appended. Returns post ID and slug.",
  {
    workspace_id: z.string().describe("UUID of the workspace"),
    title: z.string().describe("Post title"),
    content: z.string().describe("Post content in markdown (HTML tags allowed). Parsed via markdown-it at render time — supports headings, lists, code blocks, links, images, tables, blockquotes, etc."),
    status: z.string().describe("Post status: 'draft' or 'published'"),
    excerpt: z.string().optional().describe("Post summary/excerpt"),
    mode: z.string().optional().describe("'manual' or 'ai' (default: manual)"),
    language: z.string().optional().describe("Language code (default: en)"),
    category: z.string().optional().describe("Category name"),
    tags: z.array(z.string()).optional().describe("Array of tag names"),
    meta_title: z.string().optional().describe("SEO title"),
    meta_description: z.string().optional().describe("SEO description"),
    meta_keywords: z.string().optional().describe("SEO keywords (comma-separated)"),
    ai_model: z.string().nullable().optional().describe("AI model used (if mode=ai)"),
    read_time: z.number().optional().describe("Estimated read time in minutes"),
    domain: z.string().nullable().optional().describe("Custom domain override"),
  },
  async (params) => {
    const { workspace_id, ...body } = params;
    return makeHttpRequest("POST", `/workspaces/${workspace_id}/blogs`, body);
  },
);

server.tool(
  "get_blog_post",
  "Get a single blog post by ID. Returns the full blog_posts row including content (raw markdown, not parsed), metadata, and stats.",
  {
    post_id: z.string().describe("UUID of the blog post"),
  },
  async (params) => {
    return makeHttpRequest("GET", `/api/blog/${params.post_id}`);
  },
);

server.tool(
  "update_blog_post",
  "Update a blog post by ID. If status changes from draft to published, published_at is set automatically. Returns updated post ID, slug, title, and status.",
  {
    post_id: z.string().describe("UUID of the blog post"),
    title: z.string().describe("Post title"),
    content: z.string().describe("Post content in markdown (HTML tags allowed). Parsed via markdown-it at render time."),
    slug: z.string().describe("Post slug (unique per workspace)"),
    status: z.string().describe("Post status: 'draft' or 'published'"),
    excerpt: z.string().optional().describe("Post summary/excerpt"),
    category: z.string().optional().describe("Category name"),
    tags: z.array(z.string()).optional().describe("Array of tag names"),
    featured_image: z.string().optional().describe("Featured image URL"),
    image_caption: z.string().optional().describe("Image caption"),
    meta_title: z.string().optional().describe("SEO title (default: title)"),
    meta_description: z.string().optional().describe("SEO description"),
    meta_keywords: z.string().optional().describe("SEO keywords (comma-separated)"),
  },
  async (params) => {
    const { post_id, ...body } = params;
    return makeHttpRequest("PUT", `/blog/${post_id}`, body);
  },
);

server.tool(
  "delete_blog_post",
  "Delete a blog post by ID (workspace-scoped). Verifies workspace access and post ownership. Returns success message.",
  {
    workspace_id: z.string().describe("UUID of the workspace"),
    post_id: z.string().describe("UUID of the blog post"),
  },
  async (params) => {
    return makeHttpRequest("DELETE", `/workspaces/${params.workspace_id}/blogs/${params.post_id}`);
  },
);

server.tool(
  "delete_blog_post_by_id",
  "Delete a blog post by ID only (without workspace scope). Only checks user_id ownership. Returns post ID and success flag.",
  {
    post_id: z.string().describe("UUID of the blog post"),
  },
  async (params) => {
    return makeHttpRequest("DELETE", `/blog/${params.post_id}`);
  },
);

server.tool(
  "check_slug",
  "Check if a slug is available. If post_id is provided, that post is excluded from the check (for editing existing posts). Returns { available: boolean, slug: string }.",
  {
    slug: z.string().describe("Slug to check"),
    post_id: z.string().optional().describe("UUID of post to exclude from check (for edits)"),
  },
  async (params) => {
    return makeHttpRequest("POST", "/api/blog/check-slug", params);
  },
);

server.tool(
  "get_blog_analytics",
  "Get blog analytics for a workspace. Returns totalReaders, newReaders, topTrafficSource, and topArticle.",
  {
    workspace_id: z.string().describe("UUID of the workspace"),
    period: z.string().optional().describe("today | yesterday | last7days | last30days | thismonth | lastmonth | custom (default: last7days)"),
    start_date: z.string().optional().describe("YYYY-MM-DD (only if period=custom)"),
    end_date: z.string().optional().describe("YYYY-MM-DD (only if period=custom)"),
  },
  async (params) => {
    const qs = new URLSearchParams();
    if (params.period) qs.set("period", params.period);
    if (params.start_date) qs.set("start_date", params.start_date);
    if (params.end_date) qs.set("end_date", params.end_date);
    const s = qs.toString();
    return makeHttpRequest("GET", `/api/workspaces/${params.workspace_id}/blog/analytics${s ? `?${s}` : ""}`);
  },
);

// ── Upload Image (HTTP — multipart to Tapsite API) ────────────────

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

server.tool(
  "upload_image",
  "Upload an image to Tapsite. Accepts either a local file path or a remote image URL. The image is converted to WebP (max 1200x1200, quality 80) and stored on S3. Returns the public URL — use it in blog content via markdown: ![alt text](url).",
  {
    file_path: z.string().optional().describe("Local file path to the image (e.g. '/Users/me/photo.png')"),
    image_url: z.string().optional().describe("URL of a remote image to download and re-upload (e.g. 'https://example.com/image.jpg')"),
  },
  async (params) => {
    if (!params.file_path && !params.image_url) {
      return {
        content: [{ type: "text" as const, text: "Either file_path or image_url is required." }],
        isError: true,
      };
    }

    try {
      let buffer: Buffer;
      let mimeType: string;
      let filename: string;

      if (params.file_path) {
        buffer = readFileSync(params.file_path);
        mimeType = IMAGE_MIME[extname(params.file_path).toLowerCase()] || "image/jpeg";
        filename = basename(params.file_path);
      } else {
        const imgRes = await fetch(params.image_url!);
        if (!imgRes.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to fetch image URL: ${imgRes.status} ${imgRes.statusText}` }],
            isError: true,
          };
        }
        buffer = Buffer.from(await imgRes.arrayBuffer());
        mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        const urlPath = new URL(params.image_url!).pathname;
        filename = basename(urlPath) || "image.jpg";
      }

      const formData = new FormData();
      formData.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

      const url = `${TAPSITE_BASE_URL}/api/assets/upload`;
      const headers: Record<string, string> = {};
      if (TAPSITE_API_KEY) {
        headers["Authorization"] = `Bearer ${TAPSITE_API_KEY}`;
      }

      const res = await fetch(url, { method: "POST", headers, body: formData });
      const text = await res.text();

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, status: res.status, statusText: res.statusText, body: parsed }, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Upload failed: ${message}` }],
        isError: true,
      };
    }
  },
);

// ── Search Images (Pexels API) ────────────────────────────────────

server.tool(
  "search_images",
  "Search for high-quality stock photos on Pexels. Returns image URLs, photographer credits, and dimensions. Use the returned URL with upload_image (image_url param) to re-upload to Tapsite, or use directly in markdown content: ![alt](url). Requires PEXELS_API_KEY env var.",
  {
    query: z.string().describe("Search term (e.g. 'office workspace', 'nature landscape')"),
    per_page: z.number().optional().describe("Results per page (default: 15, max: 80)"),
    page: z.number().optional().describe("Page number (default: 1)"),
    orientation: z.string().optional().describe("Filter: landscape | portrait | square"),
    size: z.string().optional().describe("Filter: large | medium | small"),
    color: z.string().optional().describe("Filter by color (hex code like '00a8e8' or color name like 'blue')"),
  },
  async (params) => {
    if (!PEXELS_API_KEY) {
      return {
        content: [{ type: "text" as const, text: "PEXELS_API_KEY is not set. Get a free API key at https://www.pexels.com/api/ and set it in .env" }],
        isError: true,
      };
    }

    try {
      const qs = new URLSearchParams();
      qs.set("query", params.query);
      if (params.per_page) qs.set("per_page", String(params.per_page));
      if (params.page) qs.set("page", String(params.page));
      if (params.orientation) qs.set("orientation", params.orientation);
      if (params.size) qs.set("size", params.size);
      if (params.color) qs.set("color", params.color);

      const res = await fetch(`https://api.pexels.com/v1/search?${qs.toString()}`, {
        headers: { Authorization: PEXELS_API_KEY },
      });

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, status: res.status, statusText: res.statusText, body: parsed }, null, 2) }],
          isError: true,
        };
      }

      const data = parsed as { photos?: Array<{ id: number; width: number; height: number; alt?: string; photographer: string; photographer_url: string; src: { original: string; large: string; medium: string; small: string; portrait: string; landscape: string; tiny: string } }> };

      const photos = (data.photos || []).map((p) => ({
        id: p.id,
        alt: p.alt || "",
        photographer: p.photographer,
        photographer_url: p.photographer_url,
        width: p.width,
        height: p.height,
        urls: {
          original: p.src.original,
          large: p.src.large,
          medium: p.src.medium,
          small: p.src.small,
          landscape: p.src.landscape,
          portrait: p.src.portrait,
          tiny: p.src.tiny,
        },
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ total_results: (parsed as { total_results?: number }).total_results || 0, page: params.page || 1, per_page: params.per_page || 15, photos }, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Image search failed: ${message}` }],
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
  } else {
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
