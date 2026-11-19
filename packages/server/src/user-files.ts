import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kleosErrorCodes } from '@kleos/shared';
import { KleosError } from './errors';

/** Expands a leading `~` or `~/` to the home directory, as a shell would for ~/.ssh/id_ed25519. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Reads a file the user chose in a favorite (SSH key, CA certificate). A missing or unreadable
 * file is a 400 KLEOS_FILE naming it, with the system error code (ENOENT, EACCES) as detail.
 */
export async function readUserFile(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(expandHome(path));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw new KleosError(400, {
      code: kleosErrorCodes.file,
      message: `Could not read the ${what} ${path}`,
      ...(typeof code === 'string' ? { detail: code } : {}),
    });
  }
}
