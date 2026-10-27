import type { Readable } from 'node:stream';

export interface Storage {
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
  exists(key: string): Promise<boolean>;
}

export async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
