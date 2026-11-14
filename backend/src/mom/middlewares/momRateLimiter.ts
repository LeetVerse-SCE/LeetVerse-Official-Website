import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { MOM_CONFIG } from '../config';

export function createMomRateLimiter() {
  return rateLimit({
    windowMs: MOM_CONFIG.RATE_LIMIT_WINDOW_MS,
    max: MOM_CONFIG.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      // Per user email if authenticated, else IP
      const email = (req as any).momUser?.email;
      if (email) return `user:${email}`;
      return req.ip || 'anonymous';
    },
    handler: (req: Request, res: Response) => {
      const reqId = req.requestId || (res.getHeader('X-Request-Id') as string) || 'unknown';
      res.setHeader('X-Request-Id', reqId);
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down.',
        },
      });
    },
  });
}

