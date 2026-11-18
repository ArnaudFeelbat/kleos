import { randomUUID } from 'node:crypto';
import { kleosErrorCodes, type SavedConnection } from '@kleos/shared';
import type { Session } from '../adapter/types';
import { KleosError } from '../errors';

export type OpenSession = {
  sid: string;
  connection: SavedConnection;
  session: Session;
};

/** Live database sessions by id. One window per connection holds one session. */
export class SessionRegistry {
  private readonly sessions = new Map<string, OpenSession>();

  add(connection: SavedConnection, session: Session): OpenSession {
    const entry = { sid: randomUUID(), connection, session };
    this.sessions.set(entry.sid, entry);
    return entry;
  }

  get(sid: string): OpenSession {
    const entry = this.sessions.get(sid);
    if (!entry) {
      throw new KleosError(404, { code: kleosErrorCodes.sessionNotFound, message: 'Session not found or closed' });
    }
    return entry;
  }

  /** Closes and forgets the session; closing an unknown id is a no-op. */
  async close(sid: string): Promise<void> {
    const entry = this.sessions.get(sid);
    if (!entry) return;
    this.sessions.delete(sid);
    await entry.session.close();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((sid) => this.close(sid)));
  }

  /** Sessions opened for a favorite, e.g. to close them when it is deleted. */
  forConnection(connectionId: string): OpenSession[] {
    return [...this.sessions.values()].filter((s) => s.connection.id === connectionId);
  }
}
