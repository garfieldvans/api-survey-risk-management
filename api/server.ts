import type { IncomingMessage, ServerResponse } from 'http';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';

let app: FastifyInstance | null = null;
let readyPromise: Promise<void> | null = null;

function getApp(): FastifyInstance {
  if (!app) {
    try {
      app = buildServer();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown init error';
      console.error('[server] init failed:', message);
      const fallback = (require('fastify'))({ logger: true });
      fallback.isFallback = true;
      fallback.all('/*', async () => ({
        error: 'ServerInitError',
        message,
        hint: 'Periksa Environment Variables project ini di Vercel, lalu redeploy.',
      }));
      app = fallback;
    }
  }
  return app;
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = getApp().ready();
  }
  return readyPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await ensureReady();
    const server = getApp();
    const response = await server.inject({
      method: req.method || 'GET',
      url: req.url || '/',
      headers: req.headers as Record<string, string>,
    });

    res.statusCode = response.statusCode;
    for (const [key, value] of Object.entries(response.headers)) {
      if (value) {
        res.setHeader(key, Array.isArray(value) ? value.join(', ') : String(value));
      }
    }
    res.end(response.body);
  } catch (error) {
    console.error('[handler] error:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end('Internal Server Error');
  }
}
