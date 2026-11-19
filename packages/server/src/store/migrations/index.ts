import m001 from './001_initial.sql?raw';
import m002 from './002_grid_layouts.sql?raw';
import m003 from './003_ssh_tls_window_state.sql?raw';

/** Numbered migrations, applied in order at startup against schema_version. Append only. */
export const migrations: { version: number; sql: string }[] = [
  { version: 1, sql: m001 },
  { version: 2, sql: m002 },
  { version: 3, sql: m003 },
];
