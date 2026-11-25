# Kleos — v1 spec

> Exported from the v1 spec document (2026-11-18). Tables lost their grid when exported:
> each row's cells follow one another on separate lines. The code in "Adapter contract"
> was mangled by the export; the authoritative contracts are in the code:
> `packages/server/src/adapter/types.ts` (adapter), `packages/shared/src/*.ts` (API
> schemas) and `packages/shared/src/routes.ts` (route table). The UI design is in
> `docs/design/*.dc.html` (one file per screen; open in a browser or read the markup).

## Overview

Kleos is a personal Postgres client for one Mac, in the spirit of Postico: log in to a database, then explore its schema, browse and edit rows, run queries with charts, and watch live stats.
In scope for v1:

- Saved connections with a Postico-style login form

- Schema explorer with an ER diagram

- Data grid with paging, sorting, filtering and safe editing

- SQL editor with results as a grid or a chart

- Monitoring of sessions, locks, throughput and slow queries

Out of scope for v1:

- Engines other than Postgres (the adapter layer keeps this cheap to add later)

- Schema changes through the UI (create or alter tables); use the SQL editor

- Multiple users, sync, or any hosted component

- Import and export beyond copying results as CSV

## Stack

TypeScript end to end, as a macOS desktop app built with Electron. The main process runs a small local server on Node, and the window loads the React frontend from it. electron-vite handles development and electron-builder produces Kleos.app.
Layer
Choice
Why
Runtime
Node (bundled with Electron)
Every driver and library targets it first
Server framework
Hono
Small, typed routes, runs on Node
Postgres driver
pg (node-postgres)
Mature; cursors and cancellation
App store
SQLite via better-sqlite3
One local file; native module rebuilt for Electron
Secrets
macOS Keychain
Passwords never touch the SQLite file
Frontend
React + Vite
Familiar, fast reloads
Server state
TanStack Query
Caching, polling for monitoring
ER diagram
React Flow + elkjs
Draggable nodes, automatic layout
Data grid
TanStack Table + TanStack Virtual
Virtualized rows and columns
SQL editor
CodeMirror 6
Postgres dialect, schema autocomplete
Charts
Recharts
Line, bar and scatter cover v1
Shared types
Zod schemas in a shared package
One definition for API payloads on both sides
Versions are not pinned here; take the current stable release of each at project start.

## Architecture

Three layers: a React frontend, a local server that owns every database session, and Postgres. The frontend only knows the typed API.
The four frontend modules share one typed client. Inside the server, the API calls the adapter for database work and the app store for the app's own data; passwords live in the Keychain, apart from the SQLite file.

## Connections

The start screen is a list of saved favorites; opening one shows a login form, and Connect opens the database workspace in its own window.
Form fields:
Field
Default
Notes
Nickname
Host name
Shown in the favorites list
Host
localhost
Port
5432
User
macOS username
Password
Empty
Stored in the Keychain when "Save password" is ticked
Database
Same as user
SSL mode
prefer
disable, prefer, require, verify-full
Color
None
Tints the window header for this connection
Read-only
Off
Blocks edits and opens sessions with default_transaction_read_only = on; since 0.3, every query-tab statement also runs in a read-only transaction Kleos opens and rolls back, so typed SET or BEGIN READ WRITE cannot re-enable writes
Behavior:

- Paste a URL. Pasting a postgres://user:pass@host:5432/db?sslmode=require string into any field fills the whole form.

- Test connection. Connects, runs select version(), and shows the driver's real error on failure (bad password, host unreachable, SSL required).

- Secrets. The password is stored in the macOS Keychain under service kleos, account = connection id. The SQLite file holds every other field.

- Sessions. Connecting creates a pool of up to 4 clients for the grid, schema and monitoring, plus one dedicated client per query tab so transactions and cancel behave predictably.

- Localhost only. The server binds to 127.0.0.1 and requires a random per-launch token on every request, since it holds live database sessions.

- SSH tunnel (since 0.4). "Connect through SSH": SSH host, port, user, and either the SSH agent (SSH_AUTH_SOCK) or a private key file with an optional passphrase (Keychain account `<id>:ssh`). Each session opens one ssh2 client and a local forwarder on 127.0.0.1; Host and Port are then the database as seen from the SSH server, and verify-full still checks the database's real host name. Host keys are trusted on first use (the fingerprint is shown, SHA256) and stored in app.db; a changed key is refused, and replacing it takes a deliberate second confirmation (like ssh-keygen -R). A dropped tunnel fails the next call fast with an error naming the tunnel.

- CA certificate (since 0.4). For require and verify-full, an optional CA file replaces the system CAs: verify-full checks chain and host name, require checks the chain only (libpq's verify-ca). Test connection reports whether TLS was used.

- Restored window (since 0.4). The open server tabs, the front tab, each server's query tabs (title, SQL, chart, linked saved query) and workspace tab are saved in app.db and reopened on launch; servers whose credentials aren't in the Keychain wait in a reconnect state.

## Adapter contract

Every feature talks to the database through one interface, so the frontend never sees Postgres-specific code and a second engine means one new file.
<;
test(config: ConnectionConfig, password: string | null): Promise]]><;
}

interface Session {
introspect(): Promise]]><;
fetchRows(req: RowsRequest): Promise]]><;
estimateCount(table: TableRef): Promise]]><;
applyEdits(edits: RowEdit[]): Promise]]><;
runQuery(sql: string, opts: QueryOptions): Promise]]><;
stats(kind: StatsKind): Promise]]><;
close(): Promise]]><;
}

interface QueryHandle {
id: string;
columns: ColumnMeta[];
nextPage(size: number): Promise]]><;
cancel(): Promise]]><;
close(): Promise]]><;
}

interface SchemaModel {
schemas: string[];
tables: Table[]; // columns, primary key, indexes, row estimate
foreignKeys: ForeignKey[];
views: View[];
enums: EnumType[];
}

type RowsRequest = {
table: TableRef;
limit: number;
offset: number;
sort: { column: string; dir: "asc" | "desc" }[];
filters: Filter[]; // column, operator, value; compiled to parameters
};

type RowEdit =
| { kind: "update"; table: TableRef; key: Record]]><; set: Record]]>< }
| { kind: "insert"; table: TableRef; values: Record]]>< }
| { kind: "delete"; table: TableRef; key: Record]]>< };]]>Rules the Postgres adapter follows:

- Identifiers are always quoted and values are always parameters; the adapter never builds SQL by concatenating user input.

- applyEdits runs in one transaction and fails the whole batch if any statement affects any number of rows other than 1.

- runQuery uses a server-side cursor so a 10-million-row result never loads into memory.

- cancel calls pg_cancel_backend from a second connection.

## Features

The workspace has a sidebar listing schemas, tables and views, and four tabs: Schema, Data, Query and Monitor.

### Schema and ER diagram

- Introspection reads pg_catalog once on connect and again on a manual refresh; system schemas are hidden by default.

- Each table is a React Flow node listing its columns with type, primary-key and nullable markers. Each foreign key is an edge between the two columns.

- First layout comes from elkjs. Dragging a node saves its position per connection and schema, so the diagram reopens as you left it.

- Clicking a table opens a detail panel: columns, indexes, constraints, and a "View data" link to the grid.

- A schema picker and a search box focus the diagram; above roughly 150 tables, only the selected table and its neighbors are drawn.

### Data grid and editing

- Rows load 200 at a time with server-side sorting and filtering. The footer shows the planner's row estimate, with an exact count on request.

- Filters are built per column (equals, contains, greater than, is null) and combined with AND. A raw WHERE box covers everything else.

- Foreign-key cells link to the referenced row.

- Editing existing rows requires a primary key and a connection that is not read-only. Since 0.3, tables without a primary key accept new rows (no editing or deleting existing ones).

- Edits are staged, not sent: changed cells are highlighted, new rows are marked, and deleted rows are struck through. A review panel shows the pending SQL.

- Commit applies all staged edits in one transaction; Discard drops them.

### Query editor and charts

- CodeMirror with the Postgres dialect. Autocomplete is fed by the introspected schema.

- Run executes the selection, or the statement under the cursor. Cancel stops it.

- Results stream into the same grid component, 500 rows per page, with elapsed time and row count.

- A statement that writes on a read-only connection is refused by the session, not by parsing SQL.

- Explain runs EXPLAIN (ANALYZE, FORMAT JSON) and shows the plan as an indented tree with time per node.

- Chart view: pick a chart type (line, bar, scatter), an x column and one or more y columns. Charts use the rows already loaded, capped at 5,000.

- Every run is saved to history. A query and its chart settings can be saved by name per connection.

### Monitoring

Each panel polls its source while the Monitor tab is visible and stops when it is not.
Panel
Source
Interval
Sessions
pg_stat_activity
2 s
Locks and blocked queries
pg_locks with pg_blocking_pids
2 s
Throughput and cache hit ratio
pg_stat_database
5 s
Table health (size, dead tuples, last vacuum)
pg_stat_user_tables
30 s
Index usage
pg_stat_user_indexes
30 s
Slow queries
pg_stat_statements
30 s

- Throughput is a rate, so the server keeps the previous sample and returns the difference per second, charted over the last 15 minutes in memory.

- The Sessions panel can cancel or terminate a backend, with a confirmation.

- If pg_stat_statements is not installed, the panel says so and shows the CREATE EXTENSION statement instead of an error.

## Postgres type handling

The server sends every value as a string or null, plus the column's type name, and the frontend decides how to show and edit it. This avoids JavaScript silently rounding bigint and numeric or shifting timestamps.
Type
Shown as
Edited as
int2, int4, int8
Right-aligned digits
Text input, integer check
numeric, float4, float8
Right-aligned, exact digits from the server
Text input, number check
text, varchar
First line, truncated; full value in a side panel
Text area
bool
Checkbox
Checkbox with a third state for null
date
YYYY-MM-DD
Text input, date check
timestamp
YYYY-MM-DD HH:MM:SS
Text input
timestamptz
Local time with offset; UTC on hover
Text input, offset required
json, jsonb
One-line preview; formatted tree in a side panel
Code editor with JSON validation
Arrays
{a,b,c} preview; list in a side panel
Postgres array literal
uuid
Monospace, full
Text input, format check
Enum types
Label
Dropdown of the enum's values
bytea
Size and first bytes as hex
Read-only in v1
Anything else
The server's text form
Text input, cast by Postgres
Null is shown as a dim NULL and is distinct from an empty string. Each editor has a "Set null" action, and "Set default" on inserts.
On write, values go back as text parameters with an explicit cast to the column type, so Postgres does the parsing and reports any error per cell.

## API routes

All routes are JSON over HTTP on 127.0.0.1, prefixed /api, and validated with the shared Zod schemas. :sid is the id of an open session.
Method
Path
Purpose
GET
/connections
List saved favorites
POST
/connections
Create a favorite
PUT
/connections/:id
Update a favorite
DELETE
/connections/:id
Delete a favorite and its Keychain entry
POST
/connections/test
Test form values without saving
POST
/sessions
Connect; returns sid
DELETE
/sessions/:sid
Disconnect
GET
/sessions/:sid/schema
Introspected schema model (?refresh=1 to re-read)
POST
/sessions/:sid/rows
One page of table rows
POST
/sessions/:sid/count
Exact row count for a table and filter
POST
/sessions/:sid/edits
Apply staged edits in one transaction
POST
/sessions/:sid/queries
Start a query; returns qid, columns, first page
GET
/sessions/:sid/queries/:qid/page
Next page of results
POST
/sessions/:sid/queries/:qid/cancel
Cancel a running query
DELETE
/sessions/:sid/queries/:qid
Close the cursor
GET
/sessions/:sid/stats/:kind
One monitoring snapshot
POST
/sessions/:sid/backends/:pid/cancel
Cancel or terminate a backend
GET, PUT
/layouts/:connectionId/:schema
ER diagram node positions
GET, POST
/history/:connectionId
Query history
GET, POST, PUT, DELETE
/saved-queries
Saved queries and chart settings
Errors return { code, message, detail?, position? }, carrying the Postgres error code and character position so the editor can underline the failing token.

## App store

The app's own data lives in one SQLite file at ~/Library/Application Support/Kleos/app.db. It holds no passwords.
History keeps the latest 1,000 entries per connection. Migrations are numbered SQL files applied at startup against schema_version.

## Build order

Ten milestones, each usable on its own and each reusing the one before it.

- Skeleton. Monorepo with desktop, server, web and shared packages; one command starts the Electron app in development with live reload. Done when the window shows a health check answered through the typed client.

- Connections. Favorites list, login form, URL paste, Keychain storage, Test and Connect. Done when a saved favorite reconnects after a restart without retyping the password.

- Schema sidebar. Introspection and the tree of schemas, tables and views with a column detail panel. Done when it matches \d output in psql for a real database.

- Data grid, read-only. Paging, sorting, filtering, type-aware cells, null display. Done when a table of 1 million rows opens in under 1 second and scrolls smoothly.

- Query editor. CodeMirror, run and cancel, paged results, errors underlined, history. Done when a pg_sleep(60) query cancels within 1 second.

- Charts and saved queries. Chart view on results, save and reopen by name. Done when a saved chart redraws from a fresh run.

- ER diagram. React Flow nodes and edges, elkjs layout, saved positions, schema picker. Done when positions survive a restart.

- Editing. Staged edits, review panel, single-transaction commit, read-only enforcement. Done when a failed cell rolls back the whole batch and names the cell.

- Monitoring. The six panels, rate calculation, cancel and terminate. Done when a blocked query shows its blocker.

- Packaging. App icon, native menus and shortcuts, one window per connection, build with electron-builder. Done when Kleos.app launches from the Applications folder with no terminal open.

Automated tests run against a throwaway Postgres in Docker, seeded with one table per type in the type-handling section.

## Decisions

- Name: Kleos.

- Runtime: Node.

- Form: a macOS desktop app, built with Electron so the Node server and drivers run in the main process unchanged.

- Windows: one window per connection, as in Postico (v0.1). Since 0.2: one window with a tab per connected server.

- Tables without a primary key: read-only in v0.1–0.2; since 0.3 inserts are allowed, updates and deletes are not; never editing through ctid.

- SSH tunnel: planned for v1.1, shipped in 0.4 (ssh2, local forwarder, trust on first use).

- Export (0.4): runs on the local server, which writes the file picked in the native save dialog; streamed through a cursor inside BEGIN READ ONLY (a statement with side effects fails), to a .kleos-partial file renamed on success. CSV is RFC 4180 with a UTF-8 BOM and LF; JSON keeps int8 and numeric as strings; Excel stops at 1,048,575 rows.

- Import (0.4): CSV/TSV only, into ordinary or partitioned tables, never on read-only favorites; one transaction of batched parameterized inserts, so a failure names the file line and column and nothing is imported. Unmapped columns take their default; empty cells are NULL. It runs as its own job, not mixed into staged edits.

- Read-only and remote writes (0.4): postgres_fdw writes are refused on read-only sessions (tested); dblink_exec cannot be blocked, so the workspace shows a "dblink" notice when the extension is installed.

- Settings (0.5): appearance, rows per page (100–1,000, Data tab), query timeout (Off to 15 minutes, sent as the session's statement_timeout for servers connected afterwards; a statement can still SET its own) and update checks. Owned by the main process in preferences.json; a Settings window (⌘,) and every other window hear changes at once.

- Updates (0.5): no network call of Kleos's own until the user allows it (asked once; Settings › Updates). Then one GET to GitHub's latest-release API at launch and once a day; a newer version shows an "Update available" pill with the release notes and a Download link to the DMG. Kleos never installs anything by itself: without a Developer ID it can't replace its own signed bundle safely.

- Distribution (0.5): a .dmg on GitHub Releases, never the Mac App Store; Apple silicon only (no Intel build); ad-hoc signed, not notarized — the DMG window shows the macOS 15+ first-open steps (Open Anyway in Privacy & Security); each release lists the DMG's SHA-256. The repository is public under the MIT license from 0.5.0. No crash reports for now.

- Schema editing (0.6): from the schema tab — New table…, and the table detail panel for columns (add, rename, type with optional USING, NULL, default, drop) and indexes (add, drop), plus renaming and dropping tables. Changes are staged; the server turns each into exactly one statement (identifiers quoted; types checked against a strict grammar, confirmed by Postgres and written in its spelling; defaults and USING must be one expression) and the same builder serves the preview and the run. A run is BEGIN, `lock_timeout` 10 s (so an open transaction elsewhere can't make it hang), the statements, COMMIT; any failure rolls back and names the statement. Refused on read-only favorites. Not in 0.6: foreign keys and check constraints, CREATE INDEX CONCURRENTLY.

- Diagram (0.6): tables in other schemas linked by a foreign key appear as dashed external nodes; the diagram exports as a standalone SVG built from the model (not a DOM capture) or as a PNG at 2×. Schema diff was dropped from the plan.

- Scripts (0.7): one lexer splits a script (strings, E'' strings, quoted identifiers, dollar bodies, nested comments) for Run and Run all alike. Run all runs each statement in turn on the tab's own client (a BEGIN spans what follows) and stops at the first error, naming the statement and its line.

- Parameters (0.7): $n and :name placeholders (not ::casts or :=) prompt for values sent as bind parameters, never pasted into SQL; :name becomes $n per statement. A saved query remembers its last values (paramValues). Export hides when the shown statement has placeholders (an export reruns the SQL without values).

- History search and snippets (0.7): SQLite FTS5 over past runs' SQL and errors (every word a prefix, user text always quoted), across servers, with exclusive outcomes (succeeded, failed, cancelled). Snippets are shared by every server, names unique ignoring case. Formatting uses sql-formatter (postgresql, lowercase keywords), one undo step.

- Framing (0.7.1): a table selected from outside the diagram (sidebar, ⌘K, Focus a table…), "Center on table" in the detail panel and F are framed whole and centered, 10 % margin, never past 125 %; a click inside the diagram doesn't move the view. Framing and Fit to view use setViewport: React Flow 13's fitView only queues a move until the next nodes update, and reads a plain padding number as pixels (Kleos writes percentages).

- Favorites edited to point elsewhere (0.7.2): on a saved favorite's form, changing the host, port, database, user or SSH tunnel makes a new favorite (Connect as new / Save as new), named "<database> on <host>" unless renamed, never a taken name; nickname, color, read-only, password and SSL settings still update the same favorite. "Update … instead" rewrites it on purpose, after a confirmation when the favorite is open in a tab (that tab stays on the old server). A new favorite reuses the source's Keychain password and SSH passphrase (copySecretsFrom) only on the same server — host, port and SSH tunnel — checked by the server too; Test only falls back to a stored password under the same rule. Duplicate starts a new favorite from the shown one.
