import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsStorage, S3Storage, createStorage, type Storage } from '../src/index.js';

const prefix = `test-${randomUUID()}`;
const usedKeys = new Set<string>();
const key = (name: string) => {
  const k = `scans/${prefix}/runs/r1/${name}`;
  usedKeys.add(k);
  return k;
};

const s3Config = {
  endpoint: process.env.S3_ENDPOINT!,
  bucket: process.env.S3_BUCKET!,
  accessKeyId: process.env.S3_ACCESS_KEY!,
  secretAccessKey: process.env.S3_SECRET_KEY!,
};

let fsRoot: string;
beforeAll(async () => {
  fsRoot = await mkdtemp(join(tmpdir(), 'gremlin-storage-'));
});
afterAll(async () => {
  await rm(fsRoot, { recursive: true, force: true });
  const client = new S3Client({
    endpoint: s3Config.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey },
  });
  await Promise.all(
    [...usedKeys].map((Key) => client.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key }))),
  );
});

const impls: Array<[string, () => Storage, (s: Storage, url: string, k: string) => Promise<Buffer>]> = [
  [
    'FsStorage',
    () => new FsStorage(fsRoot),
    async (_s, url) => {
      expect(url.startsWith('file://')).toBe(true);
      return readFile(fileURLToPath(url));
    },
  ],
  [
    'S3Storage',
    () => new S3Storage(s3Config),
    async (_s, url) => {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      return Buffer.from(await res.arrayBuffer());
    },
  ],
];

describe.each(impls)('%s contract', (_name, make, fetchSigned) => {
  it('round-trips a 1 MB buffer', async () => {
    const s = make();
    const k = key('roundtrip.bin');
    const data = randomBytes(1024 * 1024);
    await s.put(k, data, 'application/octet-stream');
    expect(await s.exists(k)).toBe(true);
    expect((await s.get(k)).equals(data)).toBe(true);
  });

  it('accepts a Readable body', async () => {
    const s = make();
    const k = key('stream.bin');
    const data = randomBytes(300 * 1024);
    await s.put(k, Readable.from([data.subarray(0, 100_000), data.subarray(100_000)]), 'application/octet-stream');
    expect((await s.get(k)).equals(data)).toBe(true);
  });

  it('exists is false for a missing key; get throws', async () => {
    const s = make();
    const k = `scans/${prefix}/runs/r1/missing.bin`;
    expect(await s.exists(k)).toBe(false);
    await expect(s.get(k)).rejects.toThrow();
  });

  it('signedUrl points at the same bytes', async () => {
    const s = make();
    const k = key('signed.bin');
    const data = randomBytes(64 * 1024);
    await s.put(k, data, 'application/octet-stream');
    const url = await s.signedUrl(k, 60);
    expect((await fetchSigned(s, url, k)).equals(data)).toBe(true);
  });
});

describe('FsStorage path safety', () => {
  it.each(['../evil', 'a/../../evil', '/abs/path', 'C:evil', ['a', '..', 'b'].join(String.fromCharCode(92))])('rejects %s', async (bad) => {
    const s = new FsStorage(fsRoot);
    await expect(s.put(bad, Buffer.from('x'), 'text/plain')).rejects.toThrow(/invalid storage key/i);
    await expect(s.get(bad)).rejects.toThrow(/invalid storage key/i);
    await expect(s.exists(bad)).rejects.toThrow(/invalid storage key/i);
  });
});

describe('createStorage', () => {
  it('picks S3 when S3_ENDPOINT is set, else Fs', () => {
    expect(
      createStorage({
        S3_ENDPOINT: s3Config.endpoint,
        S3_BUCKET: s3Config.bucket,
        S3_ACCESS_KEY: s3Config.accessKeyId,
        S3_SECRET_KEY: s3Config.secretAccessKey,
      }),
    ).toBeInstanceOf(S3Storage);
    expect(createStorage({ GREMLIN_STORAGE_DIR: fsRoot })).toBeInstanceOf(FsStorage);
  });
});
