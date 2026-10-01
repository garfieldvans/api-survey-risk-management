import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import { config, assertConfig } from './config';
import './fastify-config';
import { authRoutes } from './modules/auth';
import { occupationRoutes } from './modules/occupations';
import { propertyRoutes } from './modules/properties';
import { surveyRoutes } from './modules/surveys';
import { gradingRoutes } from './modules/grading';
import { attachmentRoutes } from './modules/attachments';
import { notificationRoutes } from './modules/notifications';
import { statsRoutes } from './modules/stats';
import { reportRoutes } from './modules/reports';
import { questionRoutes } from './modules/questions';
import { prisma } from './plugins/prisma';

function buildServer() {
  // Validasi env di sini (bukan saat module load) supaya errornya bisa
  // dilaporkan lewat HTTP oleh fallback app, bukan crash tanpa pesan.
  assertConfig();
  const fastify = Fastify({
    logger: true,
  });

  fastify.decorate('config', config);

  // CORS — allow web origin with credentials (cookies)
  fastify.register(fastifyCors, {
    origin: config.webOrigin.split(',').map((o: string) => o.trim()),
    credentials: true,
  });

  fastify.register(fastifyCookie);
  fastify.register(fastifyJwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: config.jwtCookieName, signed: false },
  });
  fastify.register(fastifyMultipart);

  // Health check
  // '/health' untuk akses lokal/dev. Di Vercel Services, service menerima path
  // ASLI ('/api/health'), jadi sediakan juga alias '/api/health'.
  const healthHandler = async () => ({ status: 'ok' });
  fastify.get('/health', healthHandler);
  fastify.get('/api/health', healthHandler);

  // Routers
  fastify.register(authRoutes, { prefix: '/api' });
  fastify.register(occupationRoutes, { prefix: '/api' });
  fastify.register(propertyRoutes, { prefix: '/api' });
  fastify.register(surveyRoutes, { prefix: '/api' });
  fastify.register(gradingRoutes, { prefix: '/api' });
  fastify.register(attachmentRoutes, { prefix: '/api' });
  fastify.register(notificationRoutes, { prefix: '/api' });
  fastify.register(statsRoutes, { prefix: '/api' });
  fastify.register(reportRoutes, { prefix: '/api' });
  fastify.register(questionRoutes, { prefix: '/api' });

  // Global error handler: zod validation + AppError
  fastify.setErrorHandler((error, request, reply) => {
    if (error.name === 'ZodError') {
      return reply.code(400).send({
        error: 'ValidationError',
        message: (error as any).issues
          .map((i: any) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      });
    }

    if ((error as any).statusCode && error.message) {
      const status = (error as any).statusCode;
      if (status >= 400 && status < 500) {
        return reply.code(status).send({ error: error.message });
      }
    }

    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  });

  return fastify;
}

async function main() {
  // Pakai app yang sudah dibangun di atas (sudah try/catch) — jangan
  // buildServer() lagi di sini, supaya error init tidak crash tanpa pesan.
  const fastify = app;

  // Skip DB warm-up kalau app-nya fallback (init gagal) — cukup jalan dan
  // laporkan error init lewat HTTP, biar gampang didiagnosa.
  if (!(app as any).isFallback) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      fastify.log.info('Database connection OK');
    } catch (e) {
      fastify.log.error({ err: e }, 'Database connection FAILED');
      process.exit(1);
    }
  }

  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Vercel Serverless Functions expects default export = Fastify instance.
// Bungkus init dalam try/catch: kalau env var hilang dsb., jangan sampai
// function gagal total (FUNCTION_INVOCATION_FAILED) tanpa pesan yang jelas —
// buat app darurat yang melaporkan penyebabnya lewat HTTP supaya gampang
// didiagnosa dari log maupun browser.
function buildFallbackApp(initError: unknown) {
  const message = initError instanceof Error ? initError.message : 'Unknown init error';
  console.error('[server] init failed:', message);
  const fallback = Fastify({ logger: true });
  (fallback as any).isFallback = true;
  fallback.all('/*', async () => ({
    error: 'ServerInitError',
    message,
    hint: 'Periksa Environment Variables project ini di Vercel, lalu redeploy.',
  }));
  return fallback;
}

import type { IncomingMessage, ServerResponse } from 'http';

let app: ReturnType<typeof buildServer>;
let readyPromise: Promise<any> | null = null;

try {
  app = buildServer();
} catch (err) {
  app = buildFallbackApp(err);
}

function ensureReady(): Promise<any> {
  if (!readyPromise) {
    readyPromise = Promise.resolve(app.ready());
  }
  return readyPromise;
}

// Export both the app (for local dev) and a handler (for Vercel serverless)
export { app };

// Vercel serverless handler: Vercel's @vercel/node runtime expects the
// default export to be a function with (req, res) signature.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await ensureReady();
    const response = await app.inject({
      method: (req.method || 'GET') as any,
      url: req.url || '/',
      headers: req.headers as Record<string, string>,
    });
    (res as any).statusCode = (response as any).statusCode;
    for (const [key, value] of Object.entries((response as any).headers || {})) {
      if (value) {
        res.setHeader(key, Array.isArray(value) ? value.join(', ') : String(value));
      }
    }
    res.end((response as any).body);
  } catch (error) {
    console.error('[handler] error:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end('Internal Server Error');
  }
}

if (require.main === module) {
  main();
}