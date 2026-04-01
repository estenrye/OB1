FROM denoland/deno:2.3.3

WORKDIR /app

ARG DENO_CONFIG=deno.json
ARG SERVER_ENTRY=index.ts

# Build can target different server entrypoints (Supabase or local Postgres mTLS).
COPY ${DENO_CONFIG} ./deno.json
COPY ${SERVER_ENTRY} ./index.ts
RUN deno cache index.ts

USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
