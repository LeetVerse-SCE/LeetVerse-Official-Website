import { Request, Response, NextFunction } from 'express';
import { MomErrorCode } from '../types';

export class MomError extends Error {
  public statusCode: number;
  public code: MomErrorCode;
  public details?: any;

  constructor(statusCode: number, code: MomErrorCode, message: string, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function momErrorHandler(
  err: any,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const reqId = req.requestId || (res.getHeader('X-Request-Id') as string) || 'unknown';
  res.setHeader('X-Request-Id', reqId);

  if (err instanceof MomError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Handle upstream timeout or network error
  if (err.message && err.message.includes('timed out')) {
    res.status(502).json({
      error: {
        code: 'UPSTREAM',
        message: 'Upstream service timed out. The sheet may or may not have been updated.',
      },
    });
    return;
  }

  const statusCode = err.status || err.statusCode || 500;
  console.error(`[MOM Error] [${reqId}]`, err);

  res.status(statusCode).json({
    error: {
      code: 'UPSTREAM',
      message: err.message || 'An internal error occurred in the MOM module.',
    },
  });
}

