import { config } from 'dotenv';
import { resolve } from 'node:path';

// Repo-root .env (untracked) overrides the defaults below.
config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
process.env.DATABASE_URL ??= 'postgres://gremlin:gremlin@localhost:5432/gremlin';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.GREMLIN_SECRET_KEY ??= 'test-secret';
