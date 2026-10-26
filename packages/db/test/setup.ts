import { config } from 'dotenv';
import { resolve } from 'node:path';

// Repo-root .env (untracked) overrides the default from .env.example.
config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
process.env.DATABASE_URL ??= 'postgres://gremlin:gremlin@localhost:5432/gremlin';
