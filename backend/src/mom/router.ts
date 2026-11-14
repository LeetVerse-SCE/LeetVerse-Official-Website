import express, { Router, Request, Response, NextFunction } from 'express';
import { TokenVerifier, createMomAuthMiddleware } from './middlewares/momAuth';
import { MembersLoader } from './membersLoader';
import { SheetsClient } from './sheetsClient';
import { DelegationStore } from './delegationStore';
import { HealthService } from './healthService';
import { AsyncMutex } from './mutex';
import { MomController } from './controllers/mom.controller';
import { createMomCors } from './middlewares/momCors';
import { createMomRateLimiter } from './middlewares/momRateLimiter';
import { momRequestIdMiddleware } from './middlewares/momRequestId';
import { momErrorHandler, MomError } from './middlewares/momErrorHandler';
import { MOM_CONFIG } from './config';

export interface MomRouterDependencies {
  verifyToken: TokenVerifier;
  membersLoader: MembersLoader;
  sheetsClient: SheetsClient;
  delegationStore?: DelegationStore;
  mutex?: AsyncMutex;
  now?: () => Date;
  config?: {
    sheetId?: string;
    allowedOrigins?: string;
  };
}

export function createMomRouter(deps: MomRouterDependencies): Router {
  const router = Router();

  const sheetId = deps.config?.sheetId || process.env.MOM_SHEET_ID || '';
  const now = deps.now || (() => new Date());
  const delegationStore = deps.delegationStore || new DelegationStore({ now });
  const mutex = deps.mutex || new AsyncMutex();
  const healthService = new HealthService(deps.sheetsClient, sheetId);

  // 1. Isolated Request ID
  router.use(momRequestIdMiddleware);

  // 2. Isolated CORS
  router.use(createMomCors(deps.config?.allowedOrigins));

  // 3. Isolated Body parser (limit ~100kb)
  router.use(express.json({ limit: MOM_CONFIG.REQUEST_BODY_LIMIT }));

  // 4. Isolated Rate limiter (60 req/min)
  router.use(createMomRateLimiter());

  const controller = new MomController({
    sheetsClient: deps.sheetsClient,
    membersLoader: deps.membersLoader,
    delegationStore,
    healthService,
    mutex,
    sheetId,
    now,
  });

  // Health route (No auth)
  router.get('/health', controller.health);

  // Module health check guard for all other routes
  const healthGuard = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const health = await healthService.checkHealth();
      if (!health.ok) {
        return next(
          new MomError(
            503,
            'UNAVAILABLE',
            `MOM module is unhealthy. Missing spreadsheet tabs: ${health.missingTabs.join(', ')}`
          )
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  router.use(healthGuard);

  // Auth Middleware for protected endpoints
  const authMiddleware = createMomAuthMiddleware({
    verifyToken: deps.verifyToken,
    membersLoader: deps.membersLoader,
    delegationStore,
    now,
  });

  // Protected Routes
  router.get('/me', authMiddleware, controller.getMe);
  router.get('/roster', authMiddleware, controller.getRoster);
  router.post('/attendance', authMiddleware, controller.postAttendance);
  router.post('/delegations', authMiddleware, controller.postDelegation);
  router.get('/delegations', authMiddleware, controller.getDelegations);
  router.delete('/delegations/:domain/:roll', authMiddleware, controller.deleteDelegation);

  // 404 for unknown /mom/* routes
  router.use((req: Request, res: Response, next: NextFunction) => {
    next(new MomError(404, 'VALIDATION', `MOM endpoint '${req.method} ${req.originalUrl}' not found.`));
  });

  // Isolated Error Handler
  router.use(momErrorHandler);

  return router;
}

