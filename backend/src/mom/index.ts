import { Router } from 'express';
import { auth } from '../config/firebase';
import { createMomRouter } from './router';
import { GoogleSheetsClient } from './sheetsClient';
import { defaultMembersLoader } from './membersLoader';
import { momDelegationStore } from './delegationStore';
import { momAttendanceMutex } from './mutex';
import { TokenVerifier } from './middlewares/momAuth';

const verifyProductionToken: TokenVerifier = async (idToken: string) => {
  const decoded = await auth.verifyIdToken(idToken);
  return {
    uid: decoded.uid,
    email: decoded.email || '',
    emailVerified: decoded.email_verified === true,
    name: decoded.name,
  };
};

const sheetsClient = new GoogleSheetsClient();

export const momRouter: Router = createMomRouter({
  verifyToken: verifyProductionToken,
  membersLoader: defaultMembersLoader,
  sheetsClient,
  delegationStore: momDelegationStore,
  mutex: momAttendanceMutex,
  config: {
    sheetId: process.env.MOM_SHEET_ID,
    allowedOrigins: process.env.MOM_ALLOWED_ORIGINS,
  },
});

export * from './types';
export * from './config';
export * from './pure';
export * from './router';
export * from './delegationStore';
export * from './membersLoader';
export * from './sheetsClient';
export * from './mutex';

