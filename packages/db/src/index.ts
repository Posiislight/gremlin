import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';
export { migrate } from './migrate.js';

export interface CreateDbOptions {
  /** Postgres schema to put on the connection's search_path (used for test isolation). */
  schema?: string;
}

function makeDb(url: string, options: CreateDbOptions) {
  const client = postgres(url, {
    onnotice: () => {},
    ...(options.schema ? { connection: { search_path: options.schema } } : {}),
  });
  const db = drizzle(client, { schema });
  return Object.assign(db, { close: () => client.end() });
}

export type Db = ReturnType<typeof makeDb>;

export function createDb(url: string, options: CreateDbOptions = {}): Db {
  return makeDb(url, options);
}
