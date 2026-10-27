import { Queue, type ConnectionOptions } from 'bullmq';

export const QUEUE_NAMES = ['discovery', 'agent', 'judge', 'confirm', 'live', 'reflect'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
export type Queues = Record<QueueName, Queue>;

/** Parse a redis:// or rediss:// URL into BullMQ connection options (each Queue owns its connection). */
export function connectionFromUrl(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  const db = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined;
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(db !== undefined && !Number.isNaN(db) ? { db } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

/** `prefix` namespaces the BullMQ keys (tests use a unique one per run). */
export function createQueues(redisUrl: string, options: { prefix?: string } = {}): Queues {
  const connection = connectionFromUrl(redisUrl);
  const make = (name: QueueName) =>
    new Queue(name, { connection, ...(options.prefix ? { prefix: options.prefix } : {}) });
  return Object.fromEntries(QUEUE_NAMES.map((n) => [n, make(n)])) as Queues;
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(Object.values(queues).map((q) => q.close()));
}
