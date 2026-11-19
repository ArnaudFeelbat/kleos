import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { kleosErrorCodes } from '@kleos/shared';
import { KleosError } from '../errors';

export const PARTIAL_SUFFIX = '.kleos-partial';

/**
 * A file-system failure as KLEOS_FILE, with the system code (ENOENT, EACCES…) in `detail`.
 * Wrapped at every fs call site: some of those codes (EPERM, EROFS) look like a SQLSTATE and
 * would otherwise be reported as a Postgres error.
 */
export function fileError(err: unknown, message?: string): KleosError {
  if (err instanceof KleosError) return err;
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined;
  const text = message ?? (err instanceof Error ? err.message : String(err));
  return new KleosError(400, { code: kleosErrorCodes.file, message: text, ...(code ? { detail: code } : {}) });
}

/**
 * The export's output: `${path}.kleos-partial` while writing, renamed to `path` by finish().
 * write() honours backpressure and counts the bytes; discard() deletes the partial file.
 */
export class PartialFile {
  readonly partialPath: string;
  private stream: WriteStream | null = null;
  private failure: Error | null = null;
  bytes = 0;

  constructor(readonly path: string) {
    this.partialPath = `${path}${PARTIAL_SUFFIX}`;
  }

  /** Opens the partial file (truncating a leftover one). */
  async open(): Promise<WriteStream> {
    const stream = createWriteStream(this.partialPath, { flags: 'w' });
    stream.on('error', (err) => {
      this.failure ??= err;
    });
    try {
      await once(stream, 'open');
    } catch (err) {
      throw fileError(err);
    }
    this.stream = stream;
    return stream;
  }

  /** Writes a chunk and waits for the disk to catch up when the stream's buffer is full. */
  async write(chunk: string | Buffer): Promise<void> {
    const stream = this.requireStream();
    this.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (!stream.write(chunk)) await this.drain(stream);
  }

  /** Throws the stream's error, if any, as KLEOS_FILE. */
  check(): void {
    if (this.failure) throw fileError(this.failure);
  }

  /** Flushes, closes and renames the partial file to its final name. */
  async finish(): Promise<void> {
    const stream = this.requireStream();
    try {
      await new Promise<void>((resolve, reject) => {
        stream.once('error', reject);
        stream.end(() => resolve());
      });
      this.check();
      await rename(this.partialPath, this.path);
    } catch (err) {
      throw fileError(err);
    }
  }

  /** Closes and deletes the partial file; never throws. */
  async discard(): Promise<void> {
    const stream = this.stream;
    if (stream && !stream.destroyed) {
      await new Promise<void>((resolve) => {
        stream.once('close', () => resolve());
        stream.destroy();
      });
    }
    await unlink(this.partialPath).catch(() => undefined);
  }

  private async drain(stream: WriteStream): Promise<void> {
    this.check();
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        stream.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        stream.off('drain', onDrain);
        reject(fileError(err));
      };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    });
  }

  private requireStream(): WriteStream {
    if (!this.stream) throw new Error('The export file is not open');
    this.check();
    return this.stream;
  }
}
