import { config } from 'dotenv';
import { resolve } from 'node:path';

// Repo-root .env (untracked) overrides the defaults from .env.example.
config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_BUCKET ??= 'gremlin';
process.env.S3_ACCESS_KEY ??= 'gremlin';
process.env.S3_SECRET_KEY ??= 'gremlin-secret';
