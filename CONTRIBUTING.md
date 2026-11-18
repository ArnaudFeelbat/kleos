# Contributing to Kleos

Thanks for your interest! Kleos is a small, opinionated app; these notes keep changes
consistent with how it is built.

## Before you start

- For anything larger than a fix, open an issue first so we can agree on the approach.
- Read the [spec](docs/SPEC.md) for the product rules (exact values as text, staged edits in
  one transaction, read-only enforced by Postgres, …).

## Setup

macOS, Node 24, pnpm 11 and Docker (OrbStack works).

```sh
pnpm install
pnpm dev
```

If a server test fails with a `NODE_MODULE_VERSION` error, an install step rebuilt
better-sqlite3 for plain Node: run `pnpm --dir apps/desktop run postinstall`.

## Making a change

- **Contracts first.** API shapes live in `packages/shared` (Zod); the route table is in
  `packages/shared/src/routes.ts`. Change them deliberately and keep both sides typed.
- **Never build SQL from input.** Quote identifiers (`quoteIdent`), send values as
  parameters with an explicit cast.
- **Use the design tokens** in `packages/web/src/styles.css` — no hard-coded colors. Keep
  text at 4.5:1 contrast and never signal state by color alone.
- **Tests with the change.** Pure logic gets unit tests; UI behaviour gets Testing Library
  tests; database behaviour gets an integration test in `packages/server/test` (real
  Postgres via Testcontainers).

## Checks

All of these must pass before a pull request is merged (CI runs them too):

```sh
pnpm typecheck
pnpm lint
pnpm exec prettier --check .
pnpm test
```

For visible changes, include before/after screenshots — `scripts/ui-tour.mjs` can take
them for you.

## Commits and pull requests

- Small, focused pull requests with a clear description of the user-visible effect.
- Commit messages in the imperative, prefixed by type: `feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `test:`.
- User-facing changes get an entry in [CHANGELOG.md](CHANGELOG.md) (written in French).
