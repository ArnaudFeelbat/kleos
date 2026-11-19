import { isIP } from 'node:net';
import { type ConnectionOptions, checkServerIdentity } from 'node:tls';
import type pg from 'pg';
import type { ConnectionConfig } from '@kleos/shared';
import { KleosError, connectionErrorBody, isPgError } from '../../errors';
import { readUserFile } from '../../user-files';
import { textTypes } from './types';

export const APPLICATION_NAME = 'Kleos';

/** Time allowed to open a connection (and, for the pool, to wait for a free client). */
const CONNECT_TIMEOUT_MS = 15_000;

export type SslSetting = false | ConnectionOptions;

/**
 * SSL settings to try, in order. `prefer` tries TLS without verification first and falls back
 * to plain only when the server refuses TLS.
 *
 * With a private CA (`ca`, from sslRootCertPath) only that CA is trusted, as libpq's sslrootcert:
 * - verify-full checks the chain against it and the certificate against the favorite's host;
 * - require checks the chain but not the host name (libpq's verify-ca, which require becomes
 *   when a root certificate is given);
 * - prefer and disable never verify, so they ignore it.
 * The host name is always the favorite's own host, also through an SSH tunnel, where the socket
 * itself goes to 127.0.0.1.
 */
export function sslAttempts(config: ConnectionConfig, ca: Buffer | null = null): SslSetting[] {
  // SNI takes a DNS name only; an IP address is still checked against the certificate below.
  const sni = isIP(config.host) === 0 ? { servername: config.host } : {};
  switch (config.sslMode) {
    case 'disable':
      return [false];
    case 'require':
      return ca
        ? [{ rejectUnauthorized: true, ca, ...sni, checkServerIdentity: () => undefined }]
        : [{ rejectUnauthorized: false }];
    case 'verify-full':
      return [
        {
          rejectUnauthorized: true,
          ...(ca ? { ca } : {}),
          ...sni,
          checkServerIdentity: (_host, cert) => checkServerIdentity(config.host, cert),
        },
      ];
    case 'prefer':
      return [{ rejectUnauthorized: false }, false];
  }
}

/** The private CA of the favorite, for the modes that verify; KLEOS_FILE when unreadable. */
export async function readRootCert(config: ConnectionConfig): Promise<Buffer | null> {
  if (!config.sslRootCertPath || (config.sslMode !== 'require' && config.sslMode !== 'verify-full')) return null;
  return readUserFile(config.sslRootCertPath, 'CA certificate');
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

/** Where the socket goes when it is not the favorite's host: the local end of an SSH tunnel. */
export type Endpoint = { host: string; port: number };

/** Client settings shared by test(), the pool and the per-tab clients. */
export function clientConfig(
  config: ConnectionConfig,
  password: string | null,
  ssl: SslSetting,
  endpoint: Endpoint | null = null,
): pg.ClientConfig {
  return {
    host: endpoint?.host ?? config.host,
    port: endpoint?.port ?? config.port,
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

/** OpenSSL's verification failures, as Node reports them in `code`. */
const UNTRUSTED_CERT_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'INVALID_CA',
]);

/** What a TLS verification failure means for the user, or null for any other error. */
function tlsFailure(code: string | undefined): string | null {
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return "The server's TLS certificate does not match its host name";
  if (code && UNTRUSTED_CERT_CODES.has(code)) return "The server's TLS certificate is not trusted";
  return null;
}

/**
 * Postgres errors keep their SQLSTATE (the HTTP layer maps them); network, TLS and protocol
 * failures become KLEOS_CONNECTION with the driver's message, prefixed with what it means when
 * the server's certificate failed verification (OpenSSL's own words are cryptic).
 */
export function toConnectError(err: unknown): unknown {
  if (err instanceof KleosError || isPgError(err)) return err;
  const body = connectionErrorBody(err);
  const tls = tlsFailure(body.detail);
  return new KleosError(502, tls ? { ...body, message: `${tls}: ${body.message}` } : body);
}

/**
 * Tries each SSL setting in turn with `open`, moving to the next only when the server refuses
 * TLS. Returns what `open` returned with the setting that worked.
 */
export async function withSslFallback<T>(
  config: ConnectionConfig,
  open: (ssl: SslSetting) => Promise<T>,
): Promise<{ value: T; ssl: SslSetting }> {
  const attempts = sslAttempts(config, await readRootCert(config));
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
