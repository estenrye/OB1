FROM denoland/deno:2.3.3

WORKDIR /app

# Copy dependency manifest and cache dependencies first for better layer reuse.
COPY deno.json ./
COPY index.ts ./
RUN deno cache index.ts

USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "index.ts"]
