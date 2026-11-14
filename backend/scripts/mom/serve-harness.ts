import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { createMomRouter } from '../../src/mom/router';
import { GoogleSheetsClient } from '../../src/mom/sheetsClient';
import { FixtureMembersLoader, FirestoreMembersLoader } from '../../src/mom/membersLoader';
import { DelegationStore } from '../../src/mom/delegationStore';
import { AsyncMutex } from '../../src/mom/mutex';
import { TokenVerifier } from '../../src/mom/middlewares/momAuth';
import { VerifiedUser, Member } from '../../src/mom/types';

// Refuse to run in production
if (process.env.NODE_ENV === 'production') {
  console.error('❌ SAFETY BLOCK: Test harness cannot run in production mode (NODE_ENV=production).');
  process.exit(1);
}

const PORT = 4010;
const testSheetId = process.env.MOM_TEST_SHEET_ID;

if (!testSheetId) {
  console.warn('⚠️  Warning: MOM_TEST_SHEET_ID is not set in .env. Test harness will start in unhealthy state until configured.');
}

// Clock Control
let virtualClockOffsetMs = 0;
const harnessNow = (): Date => {
  return new Date(Date.now() + virtualClockOffsetMs);
};

// Fake Token Verifier
const harnessVerifyToken: TokenVerifier = async (token: string): Promise<VerifiedUser> => {
  if (token.startsWith('test-unverified:')) {
    const email = token.replace('test-unverified:', '').trim().toLowerCase();
    return {
      uid: `test-unverified-${email}`,
      email,
      emailVerified: false,
      name: `Unverified ${email}`,
    };
  }

  if (token.startsWith('test:')) {
    const email = token.replace('test:', '').trim().toLowerCase();
    return {
      uid: `test-${email}`,
      email,
      emailVerified: true,
      name: `Test User (${email})`,
    };
  }

  throw new Error(`Invalid test token: ${token}. Use 'test:<email>' or 'test-unverified:<email>'.`);
};

// Members Source
const args = process.argv.slice(2);
const membersSource = args.find((a) => a.startsWith('--members='))?.split('=')[1] || 'fixtures';

let membersLoader;
if (membersSource === 'firestore') {
  console.log('📦 Using real Firestore members loader');
  membersLoader = new FirestoreMembersLoader();
} else {
  const fixturesPath = path.join(__dirname, 'fixtures', 'members.json');
  console.log(`📦 Using fixture members from: ${fixturesPath}`);
  const rawFixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as Member[];
  membersLoader = new FixtureMembersLoader(rawFixtures);
}

const delegationStore = new DelegationStore({ now: harnessNow });
const mutex = new AsyncMutex();
const sheetsClient = new GoogleSheetsClient();

const app = express();
app.use(express.json());

// Harness Clock Control Endpoints
app.post('/__harness/advance-clock', (req, res) => {
  const minutes = Number(req.body.minutes || 0);
  virtualClockOffsetMs += minutes * 60 * 1000;
  res.json({
    ok: true,
    advancedMinutes: minutes,
    currentVirtualTime: harnessNow().toISOString(),
  });
});

app.post('/__harness/reset-clock', (req, res) => {
  virtualClockOffsetMs = 0;
  res.json({
    ok: true,
    currentVirtualTime: harnessNow().toISOString(),
  });
});

// Mount MOM router at /mom
const momRouter = createMomRouter({
  verifyToken: harnessVerifyToken,
  membersLoader,
  sheetsClient,
  delegationStore,
  mutex,
  now: harnessNow,
  config: {
    sheetId: testSheetId || 'mock-test-sheet-id',
    allowedOrigins: '*',
  },
});

app.use('/mom', momRouter);

const server = app.listen(PORT, () => {
  console.log(`\n============================================================`);
  console.log(`🚀 MOM TEST HARNESS SERVER RUNNING ON PORT ${PORT}`);
  console.log(`MOM Base URL: http://localhost:${PORT}/mom`);
  console.log(`MOM_TEST_SHEET_ID: ${testSheetId || 'NOT SET'}`);
  console.log(`Members Source: ${membersSource}`);
  console.log(`Virtual Clock: ${harnessNow().toISOString()}`);
  console.log(`============================================================\n`);

  console.log(`👉 Ready-made curl test examples:`);
  console.log(`\n1. Health Check (no auth):`);
  console.log(`   curl http://localhost:${PORT}/mom/health\n`);

  console.log(`2. Executive Identity (/me):`);
  console.log(`   curl -H "Authorization: Bearer test:2105101@kiit.ac.in" http://localhost:${PORT}/mom/me\n`);

  console.log(`3. Web Dev Lead Identity (/me):`);
  console.log(`   curl -H "Authorization: Bearer test:2105201@kiit.ac.in" http://localhost:${PORT}/mom/me\n`);

  console.log(`4. Lead fetching own roster:`);
  console.log(`   curl -H "Authorization: Bearer test:2105201@kiit.ac.in" "http://localhost:${PORT}/mom/roster?scope=web-dev"\n`);

  console.log(`5. Lead forbidden from fetching another domain (403):`);
  console.log(`   curl -i -H "Authorization: Bearer test:2105201@kiit.ac.in" "http://localhost:${PORT}/mom/roster?scope=cloud"\n`);

  console.log(`6. Advance Clock by 2 hours:`);
  console.log(`   curl -X POST -H "Content-Type: application/json" -d '{"minutes": 120}' http://localhost:${PORT}/__harness/advance-clock\n`);
});

export { app, server };

