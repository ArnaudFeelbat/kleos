import type { DatabaseAdapter } from '../adapter/types';
import type { SessionRegistry } from '../sessions/registry';
import type { AppStore, SecretStore } from '../store/types';

/** Everything the routes need, injected so tests can swap any part. */
export type ServerDeps = {
  adapter: DatabaseAdapter;
  store: AppStore;
  secrets: SecretStore;
  sessions: SessionRegistry;
  version: string;
};
