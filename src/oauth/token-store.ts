import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TokenSet, TokenStore } from './types.js';

/** Process-local store for tests, prototypes and the demo server. */
export class MemoryTokenStore implements TokenStore {
  readonly #tokens = new Map<string, TokenSet>();

  get(connectionId: string): Promise<TokenSet | undefined> {
    const tokens = this.#tokens.get(connectionId);
    return Promise.resolve(tokens === undefined ? undefined : { ...tokens });
  }

  set(connectionId: string, tokens: TokenSet): Promise<void> {
    this.#tokens.set(connectionId, { ...tokens });
    return Promise.resolve();
  }

  delete(connectionId: string): Promise<void> {
    this.#tokens.delete(connectionId);
    return Promise.resolve();
  }
}

/**
 * Stores all connections in one JSON file. Writes go to a temporary file that is then renamed
 * over the original, so a crash mid-write never leaves a truncated file. Operations are
 * serialized within the process; it is not meant to be shared by several processes.
 *
 * Tokens are stored in plaintext (file mode 0600). Use an encrypted store in production.
 */
export class FileTokenStore implements TokenStore {
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  get(connectionId: string): Promise<TokenSet | undefined> {
    return this.#serialize(async () => (await this.#read()).get(connectionId));
  }

  set(connectionId: string, tokens: TokenSet): Promise<void> {
    return this.#serialize(async () => {
      const all = await this.#read();
      all.set(connectionId, tokens);
      await this.#write(all);
    });
  }

  delete(connectionId: string): Promise<void> {
    return this.#serialize(async () => {
      const all = await this.#read();
      if (!all.delete(connectionId)) return;
      await this.#write(all);
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation);
    this.#chain = result.catch(() => undefined);
    return result;
  }

  async #read(): Promise<Map<string, TokenSet>> {
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8')) as Record<string, TokenSet>;
      return new Map(Object.entries(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
  }

  async #write(all: Map<string, TokenSet>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(Object.fromEntries(all), null, 2), { mode: 0o600 });
    await rename(temp, this.#path);
  }
}
