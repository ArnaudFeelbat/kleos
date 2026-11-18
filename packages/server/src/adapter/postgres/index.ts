import type { DatabaseAdapter } from '../types';

/**
 * The Postgres implementation of DatabaseAdapter (node-postgres + pg-cursor).
 * PLACEHOLDER: implemented in the adapter milestone.
 */
export function createPostgresAdapter(): DatabaseAdapter {
  return {
    async connect() {
      throw new Error('Postgres adapter is not implemented yet');
    },
    async test() {
      throw new Error('Postgres adapter is not implemented yet');
    },
  };
}
