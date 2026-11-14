import { Request, Response, NextFunction } from 'express';
import { VerifiedUser, ResolvedAccess, Member } from '../types';
import { MembersLoader } from '../membersLoader';
import { DelegationStore } from '../delegationStore';
import { resolveAccess, roleOf } from '../pure';
import { MomError } from './momErrorHandler';
import { logAuditEvent } from '../auditLogger';

export type TokenVerifier = (token: string) => Promise<VerifiedUser>;

declare global {
  namespace Express {
    interface Request {
      momUser?: VerifiedUser;
      momAccess?: ResolvedAccess;
    }
  }
}

export function createMomAuthMiddleware(deps: {
  verifyToken: TokenVerifier;
  membersLoader: MembersLoader;
  delegationStore: DelegationStore;
  now?: () => Date;
}) {
  const { verifyToken, membersLoader, delegationStore, now = () => new Date() } = deps;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(
        new MomError(401, 'UNAUTHENTICATED', 'Missing or malformed Authorization header.')
      );
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      return next(new MomError(401, 'UNAUTHENTICATED', 'Empty bearer token.'));
    }

    let user: VerifiedUser;
    try {
      user = await verifyToken(token);
    } catch (err: any) {
      return next(
        new MomError(401, 'UNAUTHENTICATED', `Invalid authentication token: ${err.message}`)
      );
    }

    if (!user.email) {
      return next(
        new MomError(401, 'UNAUTHENTICATED', 'Token does not contain an email address.')
      );
    }

    if (!user.emailVerified) {
      return next(
        new MomError(403, 'FORBIDDEN', 'Email address has not been verified.')
      );
    }

    user.email = user.email.trim().toLowerCase();

    // Load members
    let members: Member[];
    try {
      members = await membersLoader.getMembers();
    } catch (err: any) {
      return next(
        new MomError(502, 'UPSTREAM', 'Failed to retrieve members list from database.')
      );
    }

    // Grantor validator for active delegations
    const validateGrantor = (grantorRoll: string, domain: string): boolean => {
      const grantor = members.find(
        (m) => m.rollNo && m.rollNo.trim() === grantorRoll.trim() && m.status === 'active'
      );
      if (!grantor) return false;
      const gRole = roleOf(grantor);
      if (gRole === 'executive') return true;
      if (gRole === 'lead' && grantor.domain.trim().toLowerCase() === domain.trim().toLowerCase()) {
        return true;
      }
      return false;
    };

    const activeDelegations = delegationStore.getActiveDelegations(validateGrantor);

    // Resolve access
    const access = resolveAccess({
      user,
      members,
      activeDelegations,
      now: now(),
      validateGrantor,
    });

    if (access.scope.length === 0) {
      logAuditEvent({
        ts: now().toISOString(),
        requestId: req.requestId || 'unknown',
        actorEmail: user.email,
        role: access.role,
        action: 'access_denied',
        scope: [],
        outcome: 'denied',
        details: { reason: 'No domain scope or active delegation' },
      });

      return next(
        new MomError(
          403,
          'FORBIDDEN',
          'Access denied. You do not have an active lead/executive role or delegation.'
        )
      );
    }

    req.momUser = user;
    req.momAccess = access;
    next();
  };
}

