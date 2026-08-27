# Claude Opus Handoff

Status on 2026-06-09:

- T1 scaffold is complete: pnpm workspace, turbo, strict TypeScript, ESLint, Vitest, GitHub Actions, package stubs, Docker Compose for app + ClickHouse + Postgres.
- T2 registry builder is complete: `@tracecontrol/registry` compiles a bot registry from the two approved MIT sources plus `src/custom-bots.yaml`.
- Snapshot committed in the working tree: `packages/registry/bots.compiled.json` with 1539 entries.
- Attribution added in root `NOTICE`.

Verified commands:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
docker compose -f deploy/compose.yml --env-file deploy/.env.example config
```

Next suggested task:

T3 in `06-prompt-codex.md`: implement `packages/detector` UA classification over the compiled registry. Write fixture tests first, including real AI bots, search engines, browsers, curl, empty/garbage UA strings, then implement exact/token/regex matching and the benchmark target.

Important constraints:

- Do not copy AGPL code from Logwick.
- Do not embed Dark Visitors / Known Agents proprietary data or Cloudflare Radar CC BY-NC data.
- Keep detector runtime dependency-free.
- Keep classification server-side; sensors stay raw-event and fail-open.
