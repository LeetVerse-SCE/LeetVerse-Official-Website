import cors from 'cors';
import { RequestHandler } from 'express';

export function createMomCors(allowedOriginsConfig?: string): RequestHandler {
  const allowed = (allowedOriginsConfig || process.env.MOM_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const isDev = process.env.NODE_ENV !== 'production';

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, server-to-server)
      if (!origin) return callback(null, true);

      // In development, allow localhost / 127.0.0.1 on any port
      if (
        isDev &&
        (/^http:\/\/localhost(:\d+)?$/.test(origin) ||
          /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin))
      ) {
        return callback(null, true);
      }

      if (allowed.includes(origin) || allowed.includes('*')) {
        return callback(null, true);
      }

      return callback(
        new Error(`CORS blocked: Origin '${origin}' is not authorized for MOM API.`)
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });
}

