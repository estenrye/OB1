# Proposal: Local PostgreSQL mTLS for Open Brain MCP

> Superseded: the repository is currently configured for local PostgreSQL username/password auth instead of mTLS.

## Goal

Run the MCP server against a local PostgreSQL container and require mutual TLS (mTLS) between MCP and PostgreSQL.

## Current constraints in this repo

1. The main server in `server/index.ts` uses Supabase REST/RPC (`@supabase/supabase-js`), not direct PostgreSQL.
2. The direct-Postgres implementation in `integrations/kubernetes-deployment/index.ts` uses `deno-postgres` (`postgres` import), whose TLS options include CA verification but not client certificate/private key parameters required for strict mTLS.

Because of this, strict mTLS requires both:
- Moving from Supabase RPC calls to direct SQL calls.
- Using a Postgres client that supports client cert + private key.

## Recommended design

### 1) Add a dedicated local mTLS server entrypoint

Create a new file `server/index.local-postgres.ts` (or replace `server/index.ts` if you want local-only) that:

- Reuses MCP tool logic from `integrations/kubernetes-deployment/index.ts`.
- Uses `npm:pg` (node-postgres) for DB access, because it supports mTLS settings via `ssl`:
  - `ca`
  - `cert`
  - `key`
  - `rejectUnauthorized`

### 2) Add a local Deno manifest for mTLS mode

Create `server/deno.local-postgres.json`:

```json
{
  "imports": {
    "@hono/mcp": "npm:@hono/mcp@0.1.1",
    "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@1.24.3",
    "hono": "npm:hono@4.9.2",
    "zod": "npm:zod@4.1.13",
    "pg": "npm:pg@8.13.3"
  }
}
```

### 3) Add mTLS DB connection config in MCP server

In `server/index.local-postgres.ts`, use env vars:

- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `PGSSLROOTCERT`
- `PGSSLCERT`
- `PGSSLKEY`
- `MCP_ACCESS_KEY`

Example connection setup:

```ts
import { Pool } from "pg";

const pool = new Pool({
  host: Deno.env.get("DB_HOST") || "postgres",
  port: parseInt(Deno.env.get("DB_PORT") || "5432", 10),
  database: Deno.env.get("DB_NAME") || "openbrain",
  user: Deno.env.get("DB_USER") || "openbrain",
  password: Deno.env.get("DB_PASSWORD") || "",
  ssl: {
    ca: Deno.readTextFileSync(Deno.env.get("PGSSLROOTCERT") || "/certs/ca.crt"),
    cert: Deno.readTextFileSync(Deno.env.get("PGSSLCERT") || "/certs/client.crt"),
    key: Deno.readTextFileSync(Deno.env.get("PGSSLKEY") || "/certs/client.key"),
    rejectUnauthorized: true,
  },
  max: 20,
});
```

Then migrate data access calls from Supabase RPC/query builder to SQL (the same pattern already implemented in `integrations/kubernetes-deployment/index.ts`).

### 4) Add Postgres TLS server config

Add a new file `deploy/postgres/pg_hba.conf`:

```conf
# TYPE  DATABASE    USER        ADDRESS         METHOD
hostssl all         all         all             cert clientcert=verify-full
```

Notes:
- This requires the client cert CN to map to a DB role (for example CN=openbrain mapped to role openbrain).
- If you want password + cert, use:
  - `hostssl all all all scram-sha-256 clientcert=verify-full`

### 5) Add local compose stack with cert mounts

Create `docker-compose.mtls.yml`:

```yaml
services:
  postgres:
    image: postgres:18.3
    container_name: open-brain-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: openbrain
      POSTGRES_USER: openbrain
      POSTGRES_PASSWORD: openbrain_password
    command:
      - postgres
      - -c
      - ssl=on
      - -c
      - ssl_cert_file=/var/lib/postgresql/certs/server.crt
      - -c
      - ssl_key_file=/var/lib/postgresql/certs/server.key
      - -c
      - ssl_ca_file=/var/lib/postgresql/certs/ca.crt
      - -c
      - hba_file=/var/lib/postgresql/certs/pg_hba.conf
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./deploy/certs/postgres:/var/lib/postgresql/certs:ro
      - ./deploy/postgres/pg_hba.conf:/var/lib/postgresql/certs/pg_hba.conf:ro

  open-brain-mcp:
    build:
      context: ./server
      dockerfile: Dockerfile
    container_name: open-brain-mcp
    restart: unless-stopped
    depends_on:
      - postgres
    ports:
      - "8000:8000"
    environment:
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: openbrain
      DB_USER: openbrain
      DB_PASSWORD: openbrain_password
      PGSSLROOTCERT: /certs/ca.crt
      PGSSLCERT: /certs/client.crt
      PGSSLKEY: /certs/client.key
      MCP_ACCESS_KEY: ${MCP_ACCESS_KEY}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
    volumes:
      - ./deploy/certs/client:/certs:ro

volumes:
  pgdata:
```

PostgreSQL 18.3 note:
- Open Brain relies on `pgvector`, so with `postgres:18.3` you must ensure `pgvector` is installed in the container image and run `CREATE EXTENSION IF NOT EXISTS vector;` during init.
- If your base image does not include `pgvector`, build a small custom image `FROM postgres:18.3` that installs the extension.

### 6) Update server Dockerfile for local-postgres mode

Update `server/Dockerfile` to accept build args for the entrypoint and manifest:

```Dockerfile
FROM denoland/deno:2.3.3

WORKDIR /app

ARG DENO_CONFIG=deno.local-postgres.json
ARG SERVER_ENTRY=index.local-postgres.ts

COPY ${DENO_CONFIG} ./deno.json
COPY ${SERVER_ENTRY} ./index.ts
RUN deno cache index.ts

USER deno
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
```

This keeps one Dockerfile while allowing local mTLS and existing Supabase modes.

## Certificate layout

Expected local files:

- `deploy/certs/ca/ca.crt`
- `deploy/certs/postgres/server.crt`
- `deploy/certs/postgres/server.key`
- `deploy/certs/client/client.crt`
- `deploy/certs/client/client.key`

Permissions:
- `server.key` and `client.key` should be `0600`.
- Ownership inside container must satisfy Postgres requirements (server key readable by postgres user).

## Migration impact

1. Data layer migration is the main change.
2. Tool behavior remains the same (`search_thoughts`, `list_thoughts`, `thought_stats`, `capture_thought`).
3. You can keep `server/index.ts` for Supabase deployment and add `server/index.local-postgres.ts` for local mTLS mode.

## Security notes

1. Do not commit private keys.
2. Put certs and secrets in ignored paths (for example `deploy/certs/*`).
3. Use cert rotation by replacing mounted cert files and restarting services.

## Validation checklist

1. `openssl s_client -starttls postgres -connect localhost:5432 -cert deploy/certs/client/client.crt -key deploy/certs/client/client.key -CAfile deploy/certs/ca/ca.crt`
2. MCP container can connect to DB only with valid client cert.
3. Connection fails if client cert is removed or CA does not match.
4. MCP tool list endpoint still responds with auth key.
