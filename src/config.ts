import 'dotenv/config';

// Jangan throw saat module dimuat — kalau throw di sini, serverless function
// gagal total (FUNCTION_INVOCATION_FAILED) tanpa pesan yang bisa dibaca.
// Validasi dilakukan oleh assertConfig() saat buildServer(), dan errornya
// dilaporkan lewat HTTP oleh fallback app di server.ts.

export const config = {
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET ?? '',
  jwtCookieName: process.env.JWT_COOKIE_NAME ?? 'sr_token',
  databaseUrl: process.env.DATABASE_URL ?? '',
  // Object storage (S3-compatible — bawaan: Backblaze B2).
  // Karna kamu pakai B2 tanpa kartu kredit, set STORAGE_ENDPOINT + STORAGE_REGION + force path_style.
  storage: {
    endpoint: process.env.STORAGE_ENDPOINT ?? '',
    region: process.env.STORAGE_REGION ?? process.env.B2_REGION ?? '',
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true' || process.env.B2_FORCE_PATH_STYLE === 'true',
    accessKeyId: process.env.B2_KEY_ID ?? '',
    secretAccessKey: process.env.B2_APPLICATION_KEY ?? '',
    bucketName: process.env.STORAGE_BUCKET ?? 'survey-photos',
  },
};

/** Validasi env kritis saat startup. Lemparkan error yang jelas & lengkap. */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.jwtSecret) missing.push('JWT_SECRET');
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.storage?.endpoint) missing.push('STORAGE_ENDPOINT (contoh: https://s3.<region>.backblazeb2.com)');
  if (!config.storage?.region) missing.push('STORAGE_REGION / B2_REGION (contoh: us-west-002)');
  if (!config.storage?.accessKeyId) missing.push('B2_KEY_ID');
  if (!config.storage?.secretAccessKey) missing.push('B2_APPLICATION_KEY');
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
