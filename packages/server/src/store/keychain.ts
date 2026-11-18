import { Entry } from '@napi-rs/keyring';
import type { SecretStore } from './types';

const SERVICE = 'kleos';

/** macOS Keychain, service "kleos", account = connection id. */
export function createKeychainSecretStore(service = SERVICE): SecretStore {
  return {
    async get(connectionId) {
      try {
        return new Entry(service, connectionId).getPassword() ?? null;
      } catch {
        // No entry for this account.
        return null;
      }
    },
    async set(connectionId, password) {
      new Entry(service, connectionId).setPassword(password);
    },
    async delete(connectionId) {
      try {
        new Entry(service, connectionId).deletePassword();
      } catch {
        // Already absent.
      }
    },
  };
}

/** In-memory secret store for tests. */
export function createMemorySecretStore(): SecretStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async get(id) {
      return entries.get(id) ?? null;
    },
    async set(id, password) {
      entries.set(id, password);
    },
    async delete(id) {
      entries.delete(id);
    },
  };
}
