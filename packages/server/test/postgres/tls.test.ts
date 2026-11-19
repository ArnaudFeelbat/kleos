import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { KleosError } from '../../src/errors';
import { type TestDatabase, rejectionOf, startPostgres } from '../helpers/postgres';

/**
 * A private CA (sslRootCertPath) against a Postgres with ssl=on and a certificate for
 * "localhost" signed by a CA made here with openssl. Connecting to 127.0.0.1 reaches the same
 * server under a name the certificate does not carry.
 */
const adapter = createPostgresAdapter();
const dir = mkdtempSync(join(tmpdir(), 'kleos-tls-'));
let db: TestDatabase;

const OPENSSL_CONFIG = `
[req]
distinguished_name = dn
prompt = no
[dn]
CN = unused
[ca_ext]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[server_ext]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost
`;

function openssl(...args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

/** A self-signed CA; returns the path of its certificate. */
function makeCa(name: string): string {
  const ecKey = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  openssl(
    'req',
    '-x509',
    '-new',
    ...ecKey,
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.crt`,
    '-days',
    '2',
    '-config',
    'openssl.cnf',
    '-extensions',
    'ca_ext',
    '-subj',
    `/CN=Kleos test ${name}`,
  );
  return join(dir, `${name}.crt`);
}

let caPath = '';
let otherCaPath = '';

beforeAll(async () => {
  writeFileSync(join(dir, 'openssl.cnf'), OPENSSL_CONFIG);
  caPath = makeCa('ca');
  otherCaPath = makeCa('other-ca');
  openssl(
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-config',
    'openssl.cnf',
    '-subj',
    '/CN=localhost',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-set_serial',
    '1',
    '-out',
    'server.crt',
    '-days',
    '2',
    '-extfile',
    'openssl.cnf',
    '-extensions',
    'server_ext',
  );

  const certs = '/var/lib/postgresql/certs';
  db = await startPostgres({
    seeds: ['shop.sql'],
    customize: (builder) =>
      builder
        .withCopyContentToContainer([
          { content: readFileSync(join(dir, 'server.crt')), target: '/tls/server.crt' },
          { content: readFileSync(join(dir, 'server.key')), target: '/tls/server.key' },
        ])
        // Postgres wants its key owned by itself and private; copied files belong to root.
        .withEntrypoint([
          'sh',
          '-c',
          [
            `mkdir -p ${certs}`,
            `cp /tls/server.crt /tls/server.key ${certs}/`,
            `chown -R postgres:postgres ${certs}`,
            `chmod 600 ${certs}/server.key`,
            `exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=${certs}/server.crt -c ssl_key_file=${certs}/server.key`,
          ].join(' && '),
        ]),
  });
});

afterAll(async () => {
  await db?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const config = (overrides: Partial<ConnectionConfig>): ConnectionConfig => ({
  ...db.config,
  host: 'localhost',
  ...overrides,
});

const asKleos = (err: unknown) => err as KleosError;

describe('verify-full with a private CA', () => {
  it('connects when the CA signed the certificate and the host name matches', async () => {
    const result = await adapter.test(config({ sslMode: 'verify-full', sslRootCertPath: caPath }), db.password);
    expect(result.version).toMatch(/^PostgreSQL 17\./);
    expect(result.tls).toBe(true);

    const session = await adapter.connect(config({ sslMode: 'verify-full', sslRootCertPath: caPath }), db.password);
    try {
      // Pool and tab clients both run over TLS.
      const started = await session.runQuery('select ssl from pg_stat_ssl where pid = pg_backend_pid()', {
        qid: 'ssl',
        tabId: 'tab',
        pageSize: 10,
      });
      expect(started.rows).toEqual([['t']]);
      expect((await session.stats('sessions')).kind).toBe('sessions');
    } finally {
      await session.close();
    }
  });

  it('refuses a certificate from another CA, saying it is not trusted', async () => {
    const err = asKleos(
      await rejectionOf(adapter.test(config({ sslMode: 'verify-full', sslRootCertPath: otherCaPath }), db.password)),
    );
    expect(err.status).toBe(502);
    expect(err.body.code).toBe('KLEOS_CONNECTION');
    expect(err.message).toMatch(/^The server's TLS certificate is not trusted: /);
  });

  it('refuses the certificate without the private CA (system CAs only)', async () => {
    const err = asKleos(await rejectionOf(adapter.test(config({ sslMode: 'verify-full' }), db.password)));
    expect(err.body.code).toBe('KLEOS_CONNECTION');
    expect(err.message).toMatch(/^The server's TLS certificate is not trusted: /);
  });

  it('refuses a host name the certificate does not carry', async () => {
    const err = asKleos(
      await rejectionOf(
        adapter.test(config({ host: '127.0.0.1', sslMode: 'verify-full', sslRootCertPath: caPath }), db.password),
      ),
    );
    expect(err.body.code).toBe('KLEOS_CONNECTION');
    expect(err.message).toMatch(/^The server's TLS certificate does not match its host name: /);
    expect(err.body.detail).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });
});

describe('require', () => {
  it('with a private CA verifies the chain but not the host name', async () => {
    const result = await adapter.test(
      config({ host: '127.0.0.1', sslMode: 'require', sslRootCertPath: caPath }),
      db.password,
    );
    expect(result.tls).toBe(true);

    const err = asKleos(
      await rejectionOf(adapter.test(config({ sslMode: 'require', sslRootCertPath: otherCaPath }), db.password)),
    );
    expect(err.message).toMatch(/^The server's TLS certificate is not trusted: /);
  });

  it('without a CA encrypts without verifying', async () => {
    expect((await adapter.test(config({ sslMode: 'require' }), db.password)).tls).toBe(true);
  });
});

describe('the CA file', () => {
  it('is ignored by prefer, which never verifies, and TLS is reported', async () => {
    const result = await adapter.test(config({ sslMode: 'prefer', sslRootCertPath: otherCaPath }), db.password);
    expect(result.tls).toBe(true);
  });

  it('answers KLEOS_FILE when it cannot be read', async () => {
    const missing = join(dir, 'missing.pem');
    const err = asKleos(
      await rejectionOf(adapter.test(config({ sslMode: 'verify-full', sslRootCertPath: missing }), db.password)),
    );
    expect(err.status).toBe(400);
    expect(err.body).toEqual({
      code: 'KLEOS_FILE',
      message: `Could not read the CA certificate ${missing}`,
      detail: 'ENOENT',
    });
  });
});
