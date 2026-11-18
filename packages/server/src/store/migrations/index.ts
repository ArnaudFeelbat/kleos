import m001 from './001_initial.sql?raw';

/** Numbered migrations, applied in order at startup against schema_version. Append only. */
export const migrations: { version: number; sql: string }[] = [{ version: 1, sql: m001 }];
