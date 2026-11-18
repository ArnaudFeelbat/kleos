# Kleos

A personal Postgres client for the Mac, in the spirit of Postico: log in to a database,
explore its schema as an ER diagram, browse and edit rows safely, run queries with charts
and explain plans, and watch live server stats.

- Spec: [`docs/SPEC.md`](docs/SPEC.md)
- Design (one artboard per screen): [`docs/design/`](docs/design)

## Layout

| Path              | What it is                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/desktop`    | Electron main + preload (electron-vite), packaging (electron-builder)                                      |
| `packages/server` | Local Hono server: Postgres adapter (`pg`), SQLite app store, Keychain                                     |
| `packages/web`    | React frontend (Vite, Tailwind 4, shadcn/ui, TanStack Query and Virtual, React Flow, CodeMirror, Recharts) |
| `packages/shared` | Zod schemas for the API, route table, SQL helpers                                                          |

The Electron main process starts the server on `127.0.0.1` with a random per-launch
token; windows load the frontend and call the API with that token. Passwords live in the
macOS Keychain (service `kleos`); everything else lives in
`~/Library/Application Support/Kleos/app.db`.

## Commands

```sh
pnpm install          # also rebuilds better-sqlite3 for Electron
pnpm dev              # the app with live reload
pnpm typecheck
pnpm lint
pnpm test             # server tests run under Electron's Node; DB tests need Docker
pnpm package          # apps/desktop/release/Kleos-<version>-arm64.dmg and mac-arm64/Kleos.app
node scripts/smoke.mjs   # launches the built app and checks the window answers
```

Database integration tests start a throwaway Postgres with Testcontainers. With OrbStack,
set `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock` (the test helper does it when the
socket exists).

If a test fails with a `NODE_MODULE_VERSION` error, better-sqlite3 was rebuilt for plain
Node by an install step: run `pnpm --dir apps/desktop run postinstall`.
