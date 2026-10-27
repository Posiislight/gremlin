import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import type { Storage } from './types.js';

export class FsStorage implements Storage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /** Map a forward-slash key to an absolute path, rejecting traversal and absolute keys. */
  private pathFor(key: string): string {
    const bad = () => new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    const BACKSLASH = String.fromCharCode(92);
    if (!key || key.includes(String.fromCharCode(0)) || key.includes(BACKSLASH) ||key.startsWith('/') || isAbsolute(key) || /^[a-zA-Z]:/.test(key)) {
      throw bad();
    }
    if (key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) throw bad();
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw bad();
    return full;
  }

  async put(key: string, body: Buffer | Readable, _contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await pipeline(Readable.from([body]), createWriteStream(path));
    } else {
      await pipeline(body, createWriteStream(path));
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  /** file:// URL; the engine serves files over HMAC-signed HTTP paths (not done here). */
  async signedUrl(key: string, _ttlSeconds = 3600): Promise<string> {
    return pathToFileURL(this.pathFor(key)).href;
  }

  async exists(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      const st = await stat(path);
      return st.isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}
