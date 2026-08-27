# Crawlytics — self-host operations

Run Crawlytics (AI-crawler analytics) on your own server: app + ClickHouse behind
Caddy with automatic HTTPS. Single host, Docker + Docker Compose v2.

## Install (one command)

Point a domain's A record at your server, then from this `deploy/` directory:

```bash
./install.sh
```

It checks Docker, asks for your domain + email, generates secrets into `.env`
(never reuse the example values), brings the stack up, and Caddy issues a TLS
certificate on the first request. Open `https://<your-domain>`, enter your license
key on the unlock screen, then add a site under **Setup**.

Requirements: ports **80** and **443** reachable from the internet (Caddy/ACME),
the domain resolving to this server, and Docker running.

## Two builds

Both are produced from `deploy/Dockerfile` in this checkout; there is no image to
pull. `install.sh` and `compose.prod.yml` build the first one and tag it
`crawlytics-app:local`.

- **With dashboard** (default, `--build-arg INCLUDE_DASHBOARD=1`) — engine,
  ingest, query API, CLI and the React dashboard. Self-hosted installs are not
  license-gated; the dashboard is served as soon as `TC_DASHBOARD_PASSWORD` is
  set, and refuses to start unprotected in production.
- **Headless** (`--build-arg INCLUDE_DASHBOARD=0`) — the same engine, ingest,
  API and CLI with the SPA left out. Useful when you query through the API or
  MCP and do not want a login surface at all.

```bash
docker build -f deploy/Dockerfile --build-arg INCLUDE_DASHBOARD=0 -t crawlytics-app:headless ..
```

## Day-2 operations

```bash
./install.sh --upgrade     # rebuild from this checkout and restart (keeps all data)
./install.sh --uninstall   # stop the stack, keep data volumes
./install.sh --purge       # stop AND delete all data volumes (irreversible)
```

Re-running `install.sh` is safe: it reuses `.env`, never regenerates secrets, and
never deletes volumes. **Always back up before an upgrade** (below).

### Backup & restore

```bash
./backup.sh                # consistent backup (briefly stops the app to flush)
./backup.sh --online       # best-effort backup without stopping the app
./restore.sh backups/crawlytics-<timestamp>            # into an empty instance
./restore.sh backups/crawlytics-<timestamp> --force    # truncate + overwrite existing data
```

Backups contain the raw `events` table and the metadata file (sites/keys/license).
The daily rollups are rebuilt automatically on restore — do not restore them
separately. Each backup writes a `manifest.json` with an event count + checksum;
`restore.sh` verifies the restored count against it. Keep backups off-box.

### Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `CRAWLYTICS_DOMAIN` | Public domain Caddy serves + gets a cert for |
| `CRAWLYTICS_ACME_EMAIL` | Let's Encrypt contact email |
| `TC_DASHBOARD_PASSWORD` | Dashboard login. **Required** when internet-facing |
| `TC_IP_HASH_SECRET` | Salt for daily visitor-IP hashing (rotating it resets hashes) |
| `CLICKHOUSE_PASSWORD` | ClickHouse password (generated) |
| `TC_INGEST_KEYS` | Optional `key:site` seed; usually empty — onboard via the wizard |

## Ops runbook

- **Logs:** `docker compose -p crawlytics -f compose.prod.yml -f compose.tls.yml logs -f`
- **Health:** `GET /healthz` (liveness + ingest counters), `GET /readyz` (ClickHouse reachable → 200/503).
- **Disk / retention:** events carry a 13-month TTL in ClickHouse; watch the
  `clickhouse_data` volume. ClickHouse and the app are bound to the internal
  Docker network; only Caddy is published (80/443) and the app is bound to
  `127.0.0.1` — never expose port 3000 publicly.
- **TLS troubleshooting:** a `525`/cert error almost always means the domain isn't
  pointed here yet or 80/443 are blocked. Fix DNS/firewall, then `--upgrade`.
- **Privacy:** stored events drop URL query strings and reduce referers to their
  origin; human IPs are hashed daily, raw IP is kept only for bots (spoof
  detection). See `docs/sensors.md` for what each sensor sends.

## Note on the hosted tier and payments

This compose is the **self-host** stack only. The Stripe **issuer** (which holds
the license signing key) runs separately on our side and is never part of this
image — see `apps/server/src/issuer`.
