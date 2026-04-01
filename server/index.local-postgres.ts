// @ts-nocheck
// Local Postgres entrypoint — connects directly to PostgreSQL using username/password.
// Use docker-compose.local.yml to run this alongside a local Postgres 18 + pgvector container.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const DB_HOST = Deno.env.get("DB_HOST") || "postgres";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "openbrain";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") || "";

const DB_SSL_MODE = (Deno.env.get("DB_SSL_MODE") || "disable").toLowerCase();

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
const OPENROUTER_BASE = Deno.env.get("OPENROUTER_BASE") || "https://openrouter.ai/api/v1";
const OPENROUTER_EMBEDDING_MODEL =
  Deno.env.get("OPENROUTER_EMBEDDING_MODEL") || "openai/text-embedding-3-small";
const OPENROUTER_CHAT_MODEL = Deno.env.get("OPENROUTER_CHAT_MODEL") || "openai/gpt-4o-mini";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

function buildSslConfig() {
  if (DB_SSL_MODE === "disable") return false;

  return {
    rejectUnauthorized: false,
  };
}

const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  ssl: buildSslConfig(),
  max: 20,
});

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_EMBEDDING_MODEL,
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_CHAT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const embStr = `[${qEmb.join(",")}]`;

      const result = await pool.query(
        `SELECT content, metadata, created_at,
                1 - (embedding <=> $1::vector) AS similarity
         FROM thoughts
         WHERE embedding IS NOT NULL
           AND 1 - (embedding <=> $1::vector) > $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [embStr, threshold, limit]
      );

      if (!result.rows.length) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
        };
      }

      const results = result.rows.map(
        (
          t: {
            content: string;
            metadata: Record<string, unknown>;
            similarity: number;
            created_at: string;
          },
          i: number
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${result.rows.length} thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z
        .string()
        .optional()
        .describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (type) {
        conditions.push(`metadata->>'type' = $${paramIndex}`);
        params.push(type);
        paramIndex += 1;
      }
      if (topic) {
        conditions.push(`metadata->'topics' ? $${paramIndex}`);
        params.push(topic);
        paramIndex += 1;
      }
      if (person) {
        conditions.push(`metadata->'people' ? $${paramIndex}`);
        params.push(person);
        paramIndex += 1;
      }
      if (days) {
        conditions.push(`created_at >= NOW() - ($${paramIndex}::int * INTERVAL '1 day')`);
        params.push(days);
        paramIndex += 1;
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query(
        `SELECT content, metadata, created_at
         FROM thoughts
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${paramIndex}`,
        [...params, limit]
      );

      if (!result.rows.length) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const lines = result.rows.map(
        (
          t: { content: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${
            tags ? " - " + tags : ""
          })\n   ${t.content}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${result.rows.length} recent thought(s):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM thoughts");
      const dataResult = await pool.query(
        "SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC"
      );

      const count = countResult.rows[0]?.count || 0;
      const data = dataResult.rows as Array<{
        metadata: Record<string, unknown>;
        created_at: string;
      }>;

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};

      for (const r of data) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics)) {
          for (const t of m.topics) {
            topics[t as string] = (topics[t as string] || 0) + 1;
          }
        }
        if (Array.isArray(m.people)) {
          for (const p of m.people) {
            people[p as string] = (people[p as string] || 0) + 1;
          }
        }
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " -> " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client -- notes, insights, decisions, or migrated content from other systems.",
    inputSchema: {
      content: z
        .string()
        .describe(
          "The thought to capture -- a clear, standalone statement that will make sense when retrieved later by any AI"
        ),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const payload = { metadata: { ...metadata, source: "mcp" } };
      const upsertResult = await pool.query(
        "SELECT upsert_thought($1, $2::jsonb) AS result",
        [content, JSON.stringify(payload)]
      );

      const resultJson = upsertResult.rows[0]?.result as
        | { id?: string }
        | undefined;
      const thoughtId = resultJson?.id;
      if (!thoughtId) {
        throw new Error("upsert_thought did not return an id");
      }

      const embStr = `[${embedding.join(",")}]`;
      await pool.query("UPDATE thoughts SET embedding = $1::vector WHERE id = $2", [
        embStr,
        thoughtId,
      ]);

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` -- ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

const port = parseInt(Deno.env.get("PORT") || "8000", 10);
Deno.serve({ port }, app.fetch);
