import type pg from 'pg';
import type { ConnectionConfig } from '@kleos/shared';
import { KleosError, connectionErrorBody, isPgError } from '../../errors';
import { textTypes } from './types';

export const APPLICATION_NAME = 'Kleos';

/** Time allowed to open a connection (and, for the pool, to wait for a free client). */
const CONNECT_TIMEOUT_MS = 15_000;

type SslSetting = false | { rejectUnauthorized: boolean; servername?: string };

/**
 * SSL settings to try, in order. `prefer` tries TLS without verification first and falls back
 * to plain only when the server refuses TLS.
 */
export function sslAttempts(config: ConnectionConfig): SslSetting[] {
  switch (config.sslMode) {
    case 'disable':
      return [false];
    case 'require':
      return [{ rejectUnauthorized: false }];
    case 'verify-full':
      return [{ rejectUnauthorized: true, servername: config.host }];
    case 'prefer':
      return [{ rejectUnauthorized: false }, false];
  }
}

/** node-postgres's error when the server answers 'N' to the SSL request. */
export function isSslRefused(err: unknown): boolean {
  return err instanceof Error && err.message === 'The server does not support SSL connections';
}

/** The Mac's time zone, so timestamptz text comes back in local time with its offset. */
function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Escapes a value for the startup `options` string (backslash and space are special). */
function optionValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/ /g, '\\ ');
}

/** Session settings sent at startup, so they hold for every statement of every client. */
export function startupOptions(readOnly: boolean): string {
  const options = ['-c DateStyle=ISO'];
  const timeZone = localTimeZone();
  if (timeZone) options.push(`-c TimeZone=${optionValue(timeZone)}`);
  if (readOnly) options.push('-c default_transaction_read_only=on');
  return options.join(' ');
}

/** Client settings shared by test(), the pool and the per-tab clients. */
export function clientConfig(config: ConnectionConfig, password: string | null, ssl: SslSetting): pg.ClientConfig {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    // A function, so "no password" never falls back to PGPASSWORD or ~/.pgpass.
    password: password ? password : ((() => undefined) as unknown as () => string),
    ssl,
    application_name: APPLICATION_NAME,
    options: startupOptions(config.readOnly),
    types: textTypes,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    keepAlive: true,
  };
}

/**
 * Postgres errors keep their SQLSTATE (the HTTP layer maps them); network, TLS and protocol
 * failures become KLEOS_CONNECTION with the driver's message unchanged.
 */
export function toConnectError(err: unknown): unknown {
  if (err instanceof KleosError || isPgError(err)) return err;
  return new KleosError(502, connectionErrorBody(err));
}

/**
 * Tries each SSL setting in turn with `open`, moving to the next only when the server refuses
 * TLS. Returns what `open` returned with the setting that worked.
 */
export async function withSslFallback<T>(
  config: ConnectionConfig,
  open: (ssl: SslSetting) => Promise<T>,
): Promise<{ value: T; ssl: SslSetting }> {
  const attempts = sslAttempts(config);
  for (let i = 0; ; i += 1) {
    const ssl = attempts[i]!;
    try {
      return { value: await open(ssl), ssl };
    } catch (err) {
      if (i < attempts.length - 1 && isSslRefused(err)) continue;
      throw toConnectError(err);
    }
  }
}

export { CONNECT_TIMEOUT_MS };
