import { assertConfig, config } from '../src/config';
import {
  deleteObject,
  isStorageConfigured,
  presignedDownloadUrl,
  uploadFile,
} from '../src/plugins/storage';

async function main() {
  assertConfig();
  console.log('configured:', isStorageConfigured());
  console.log('bucket:', config.storage.bucketName, '| region:', config.storage.region, '| pathStyle:', config.storage.forcePathStyle);

  const key = process.argv[2] ?? `smoke/${Date.now()}.txt`;
  const body = Buffer.from(`b2 smoke test ${new Date().toISOString()}`);

  const t0 = Date.now();
  const stored = await uploadFile({ key, body, contentType: 'text/plain', contentLength: body.length });
  const tUpload = Date.now() - t0;

  const url = await presignedDownloadUrl(stored.key, 300);
  const res = await fetch(url);
  const text = await res.text();
  const match = text === body.toString();

  await deleteObject(stored.key);

  console.log(`upload ${tUpload}ms | GET ${res.status} | content match: ${match} | deleted ok`);
  if (!match || res.status !== 200) {
    throw new Error('smoke test gagal');
  }
  console.log('SMOKE OK');
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e?.name, e?.message, e?.$metadata?.httpStatusCode ?? '');
  process.exit(1);
});
