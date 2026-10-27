import { FsStorage } from './fs.js';
import { S3Storage } from './s3.js';
import type { Storage } from './types.js';

export { FsStorage, S3Storage };
export type { Storage };
export type { S3Config } from './s3.js';

type Env = Record<string, string | undefined>;

/** S3 (MinIO) when S3_ENDPOINT is set, else filesystem under GREMLIN_STORAGE_DIR. */
export function createStorage(env: Env = process.env): Storage {
  if (env.S3_ENDPOINT) {
    const need = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`${k} is required when S3_ENDPOINT is set`);
      return v;
    };
    return new S3Storage({
      endpoint: env.S3_ENDPOINT,
      bucket: need('S3_BUCKET'),
      accessKeyId: need('S3_ACCESS_KEY'),
      secretAccessKey: need('S3_SECRET_KEY'),
    });
  }
  return new FsStorage(env.GREMLIN_STORAGE_DIR || './.gremlin-storage');
}
