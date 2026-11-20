import m001 from './001_initial.sql?raw';
import m002 from './002_grid_layouts.sql?raw';
import m003 from './003_ssh_tls_window_state.sql?raw';
import m004 from './004_saved_query_params.sql?raw';
import m005 from './005_history_search.sql?raw';
import m006 from './006_snippets.sql?raw';

/** Numbered migrations, applied in order at startup against schema_version. Append only. */
export const migrations: { version: number; sql: string }[] = [
  { version: 1, sql: m001 },
  { version: 2, sql: m002 },
  { version: 3, sql: m003 },
  { version: 4, sql: m004 },
  { version: 5, sql: m005 },
  { version: 6, sql: m006 },
];
