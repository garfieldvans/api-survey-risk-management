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
  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    bucketName: process.env.R2_BUCKET_NAME ?? 'survey-reports',
    publicUrl: process.env.R2_PUBLIC_URL ?? '',
    endpoint: `https://${process.env.R2_ACCOUNT_ID ?? ''}.r2.cloudflarestorage.com`,
  },
};

/** Validasi env kritis saat startup. Lemparkan error yang jelas & lengkap. */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.jwtSecret) missing.push('JWT_SECRET');
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
