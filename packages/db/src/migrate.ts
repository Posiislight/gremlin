import { resolve } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PgDialect, PgSession } from 'drizzle-orm/pg-core';
import type { Db } from './index.js';

const migrationsFolder = resolve(import.meta.dirname, '../migrations');

/**
 * Applies the committed SQL migrations. With `schema`, the db must have been created
 * with the same `schema`: generated SQL hard-codes `"public".` in foreign keys, so it is
 * rewritten to the target schema, and the migration journal lives there too.
 */
export async function migrate(db: Db, options: { schema?: string } = {}): Promise<void> {
  const { schema } = options;
  const migrations = readMigrationFiles({ migrationsFolder });
  const target = schema
    ? migrations.map((m) => ({
        ...m,
        sql: m.sql.map((s) => s.replaceAll('"public".', `"${schema}".`)),
      }))
    : migrations;
  // Deliberate cast: drizzle's migrator can't rewrite SQL, so use the internal dialect (tied to drizzle-orm 0.45.x).
  const { dialect, session } = db as unknown as { dialect: PgDialect; session: PgSession };
  if (typeof dialect?.migrate !== 'function') {
    throw new Error('drizzle-orm internals changed: db.dialect.migrate is missing (expected drizzle-orm 0.45.x)');
  }
  await dialect.migrate(target, session, { migrationsFolder, ...(schema ? { migrationsSchema: schema } : {}) });
}
