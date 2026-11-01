import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';

// Client di-cache: membuat S3Client baru per request berarti buka koneksi TLS
// baru setiap upload/download. Config tidak berubah selama process hidup.
let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  const s = config.storage;
  client = new S3Client({
    region: s.region || 'auto',
    endpoint: s.endpoint,
    credentials: {
      accessKeyId: s.accessKeyId,
      secretAccessKey: s.secretAccessKey,
    },
    forcePathStyle: s.forcePathStyle || false,
    requestHandler: { requestTimeout: 30_000, connectionTimeout: 10_000 },
  });
  return client;
}

export interface StoredFile {
  key: string;
  url?: string;
}

export function isStorageConfigured(): boolean {
  const s = config.storage;
  return Boolean(s.endpoint && s.accessKeyId && s.secretAccessKey);
}

export async function uploadFile(
  { key, body, contentType, contentLength }: {
    key: string;
    body: Buffer;
    contentType: string;
    contentLength: number;
  },
): Promise<StoredFile> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: config.storage.bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
  );
  return { key };
}

export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: config.storage.bucketName, Key: key }));
}

export async function presignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({ Bucket: config.storage.bucketName, Key: key });
  return getSignedUrl(client, command, { expiresIn });
}