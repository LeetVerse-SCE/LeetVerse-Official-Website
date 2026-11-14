import dotenv from 'dotenv';
dotenv.config();

import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express, { Express } from 'express';
import { Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createMomRouter } from '../../src/mom/router';
import { GoogleSheetsClient } from '../../src/mom/sheetsClient';
import { FixtureMembersLoader } from '../../src/mom/membersLoader';
import { DelegationStore } from '../../src/mom/delegationStore';
import { AsyncMutex } from '../../src/mom/mutex';
import { Member } from '../../src/mom/types';
import { TAB_NAMES } from '../../src/mom/config';

// In-Memory mock sheets client for running tests when live Google credentials are not set
class MockTestSheetsClient {
  public data: Record<string, string[][]> = {};
  public meta: Record<string, any> = {};

  constructor() {
    this.reset();
  }

  public reset() {
    this.data = {};
    this.meta = {};
    const domainKeys = Object.keys(TAB_NAMES);
    for (let i = 0; i < domainKeys.length; i++) {
      const key = domainKeys[i];
      const title = TAB_NAMES[key];
      const idx = i + 1;
      this.meta[title] = {
        sheetId: Math.floor(Math.random() * 100000),
        title,
        columnCount: 26,
        rowCount: 100,
      };
      // Standard header row and 3 dummy members with unique rolls per domain
      this.data[title] = [
        ['NAME', 'ROLL NO', 'Email ID', 'PHONE'],
        [`${key} Member 1`, `2415${idx}001`, 'm1@kiit.ac.in', '9999999991'],
        [`${key} Member 2`, `2415${idx}002`, 'm2@kiit.ac.in', '9999999992'],
        [`${key} Member 3`, `2415${idx}003`, 'm3@kiit.ac.in', '9999999993'],
      ];
    }
    // Cross-tab member in web-dev and graphic-design (roll 24151001 is from web-dev)
    this.data['Graphic Designing'].push(['Cross Member', '24151001', 'm1@kiit.ac.in', '9999999991']);
    this.data['Web Development'].push(['Alice Delegate', '24158999', 'del@kiit.ac.in', '9999999999']);
  }

  async getSpreadsheetMetadata() {
    return this.meta;
  }

  async getTabValues(_id: string, titles: string[]) {
    const res: Record<string, string[][]> = {};
    titles.forEach((t) => {
      res[t] = (this.data[t] || []).map((r) => [...r]);
    });
    return res;
  }

  async getTabValuesCached(id: string, titles: string[]) {
    return this.getTabValues(id, titles);
  }

  async batchUpdate(_id: string, requests: any[]) {
    for (const req of requests) {
      if (req.updateCells) {
        const { start, rows } = req.updateCells;
        const targetSheetId = start.sheetId;
        const title = Object.keys(this.meta).find((k) => this.meta[k].sheetId === targetSheetId);
        if (!title) continue;

        const table = this.data[title];
        const startRow = start.rowIndex || 0;
        const startCol = start.columnIndex || 0;

        for (let r = 0; r < rows.length; r++) {
          const rowValues = rows[r].values || [];
          const curRow = startRow + r;
          while (table.length <= curRow) table.push([]);
          for (let c = 0; c < rowValues.length; c++) {
            const curCol = startCol + c;
            while (table[curRow].length <= curCol) table[curRow].push('');
            table[curRow][curCol] = rowValues[c].userEnteredValue?.stringValue || '';
          }
        }
      }
    }
  }
}

describe('MOM End-to-End Scenarios', () => {
  let server: Server;
  let baseUrl: string;
  let mockSheets: MockTestSheetsClient;
  let fixtureLoader: FixtureMembersLoader;
  let delegationStore: DelegationStore;
  let virtualTime = new Date('2026-11-10T12:00:00Z');

  before(async () => {
    const fixturesPath = path.join(__dirname, 'fixtures', 'members.json');
    const rawFixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as Member[];
    fixtureLoader = new FixtureMembersLoader(rawFixtures);

    mockSheets = new MockTestSheetsClient();
    delegationStore = new DelegationStore({ now: () => virtualTime });
    const mutex = new AsyncMutex();

    const verifyToken = async (token: string) => {
      if (token.startsWith('test-unverified:')) {
        return {
          uid: 'u-unver',
          email: token.replace('test-unverified:', '').trim().toLowerCase(),
          emailVerified: false,
        };
      }
      if (token.startsWith('test:')) {
        const email = token.replace('test:', '').trim().toLowerCase();
        return {
          uid: `u-${email}`,
          email,
          emailVerified: true,
          name: `User ${email}`,
        };
      }
      throw new Error('Bad token');
    };

    const router = createMomRouter({
      verifyToken,
      membersLoader: fixtureLoader,
      sheetsClient: mockSheets as any,
      delegationStore,
      mutex,
      now: () => virtualTime,
      config: {
        sheetId: 'mock-sheet-id',
        allowedOrigins: '*',
      },
    });

    const app: Express = express();
    app.use(express.json());
    app.use('/mom', router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}/mom`;
        resolve();
      });
    });
  });

  after(() => {
    server?.close();
  });

  const api = async (endpoint: string, options: any = {}) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, data: json, headers: res.headers };
  };

  it('1. Auth verification: 401 on missing/bad token, 403 on unverified/non-member', async () => {
    // Missing header -> 401
    const r1 = await api('/me');
    assert.equal(r1.status, 401);

    // Garbage token -> 401
    const r2 = await api('/me', { token: 'garbage-token' });
    assert.equal(r2.status, 401);

    // Unverified email -> 403
    const r3 = await api('/me', { token: 'test-unverified:2105101@kiit.ac.in' });
    assert.equal(r3.status, 403);

    // Non-KIIT email -> 403
    const r4 = await api('/me', { token: 'test:stranger@gmail.com' });
    assert.equal(r4.status, 403);

    // KIIT email but not a member -> 403
    const r5 = await api('/me', { token: 'test:24999999@kiit.ac.in' });
    assert.equal(r5.status, 403);
  });

  it('2. Roles: Executive has all 9 tabs and canGeneral; Lead has only primary domain', async () => {
    // President
    const pres = await api('/me', { token: 'test:2105101@kiit.ac.in' });
    assert.equal(pres.status, 200);
    assert.equal(pres.data.role, 'executive');
    assert.equal(pres.data.canGeneral, true);
    assert.equal(pres.data.domains.length, 9);

    // Web Dev Lead
    const lead = await api('/me', { token: 'test:2105201@kiit.ac.in' });
    assert.equal(lead.status, 200);
    assert.equal(lead.data.role, 'lead');
    assert.equal(lead.data.canGeneral, false);
    assert.equal(lead.data.domains.length, 1);
    assert.equal(lead.data.domains[0].key, 'web-dev');

    // Lead cannot reach other domains roster
    const cross = await api('/roster?scope=cloud', { token: 'test:2105201@kiit.ac.in' });
    assert.equal(cross.status, 403);

    // Soumya (DS Lead who lists graphic-design in domains array) cannot reach graphic-design
    const soumya = await api('/roster?scope=graphic-design', { token: 'test:2105207@kiit.ac.in' });
    assert.equal(soumya.status, 403);

    // Asst. Lead (Krishna Kasera) gets 403
    const asst = await api('/me', { token: 'test:2105203@kiit.ac.in' });
    assert.equal(asst.status, 403);

    // FIC faculty gets 403
    const fic = await api('/me', { token: 'test:subhash@kiit.ac.in' });
    assert.equal(fic.status, 403);

    // Placeholder roll (00000000) gets 403
    const dummy = await api('/me', { token: 'test:00000000@kiit.ac.in' });
    assert.equal(dummy.status, 403);
  });

  it('3. Happy Path: Domain meeting submission, direct cell check, retry already_recorded, conflict', async () => {
    mockSheets.reset();

    // Lead submits attendance
    const postRes = await api('/attendance', {
      method: 'POST',
      token: 'test:2105201@kiit.ac.in',
      body: {
        date: '2026-11-10',
        type: 'domain',
        scope: 'web-dev',
        records: [
          { roll: '24151001', status: 'P' },
          { roll: '24151002', status: 'A' },
          { roll: '24151003', status: 'P' },
          { roll: '24158999', status: 'P' },
        ],
      },
    });

    assert.equal(postRes.status, 200);
    assert.equal(postRes.data.results[0].status, 'written');
    assert.equal(postRes.data.results[0].column, 'E');

    // Check cells directly in mock sheets table
    const table = mockSheets.data['Web Development'];
    assert.equal(table[0][4], '2026-11-10 | domain | 2105201@kiit.ac.in');
    assert.equal(table[1][4], 'P');
    assert.equal(table[2][4], 'A');
    assert.equal(table[3][4], 'P');

    // Re-submit identical request -> already_recorded
    const retryRes = await api('/attendance', {
      method: 'POST',
      token: 'test:2105201@kiit.ac.in',
      body: {
        date: '2026-11-10',
        type: 'domain',
        scope: 'web-dev',
        records: [
          { roll: '24151001', status: 'P' },
          { roll: '24151002', status: 'A' },
          { roll: '24151003', status: 'P' },
          { roll: '24158999', status: 'P' },
        ],
      },
    });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.data.results[0].status, 'already_recorded');
    // Ensure no new column was created
    assert.equal(table[0].length, 5);

    // Conflict: Different user (e.g. president) submits same date and type -> 409
    const conflictRes = await api('/attendance', {
      method: 'POST',
      token: 'test:2105101@kiit.ac.in',
      body: {
        date: '2026-11-10',
        type: 'domain',
        scope: 'web-dev',
        records: [
          { roll: '24151001', status: 'P' },
          { roll: '24151002', status: 'A' },
          { roll: '24151003', status: 'P' },
          { roll: '24158999', status: 'P' },
        ],
      },
    });
    assert.equal(conflictRes.status, 409);
  });

  it('4. General meeting: Executive writes across all 9 tabs; Cross-member gets consistent status', async () => {
    mockSheets.reset();

    // Get ALL roster rolls
    const rosterRes = await api('/roster?scope=ALL', { token: 'test:2105101@kiit.ac.in' });
    assert.equal(rosterRes.status, 200);
    const members = rosterRes.data.members;

    const records = members.map((m: any) => ({
      roll: m.roll,
      status: m.roll === '24151001' ? 'P' : 'A',
    }));

    const genRes = await api('/attendance', {
      method: 'POST',
      token: 'test:2105101@kiit.ac.in',
      body: {
        date: '2026-11-10',
        type: 'general',
        scope: 'ALL',
        records,
      },
    });

    assert.equal(genRes.status, 200);
    assert.equal(genRes.data.results.length, 9);
    for (const r of genRes.data.results) {
      assert.equal(r.status, 'written');
    }

    // Verify cross-tab member (24151001) has 'P' in both Web Development and Graphic Designing
    const webTable = mockSheets.data['Web Development'];
    const graphicTable = mockSheets.data['Graphic Designing'];

    assert.equal(webTable[1][4], 'P');
    assert.equal(graphicTable[4][4], 'P'); // 24151001 was pushed at row 4
  });

  it('5. Validation checks: 422 on bad rolls, bad date, bad status', async () => {
    // Missing roll
    const v1 = await api('/attendance', {
      method: 'POST',
      token: 'test:2105201@kiit.ac.in',
      body: {
        date: '2026-11-10',
        type: 'domain',
        scope: 'web-dev',
        records: [
          { roll: '24151001', status: 'P' },
          // missing 24151002, 24151003, 24158999
        ],
      },
    });
    assert.equal(v1.status, 422);

    // Far future date
    const v2 = await api('/attendance', {
      method: 'POST',
      token: 'test:2105201@kiit.ac.in',
      body: {
        date: '2026-12-31',
        type: 'domain',
        scope: 'web-dev',
        records: [
          { roll: '24151001', status: 'P' },
          { roll: '24151002', status: 'A' },
          { roll: '24151003', status: 'P' },
          { roll: '24158999', status: 'P' },
        ],
      },
    });
    assert.equal(v2.status, 422);
  });

  it('6. Dry Run: returns plan, writes zero cells to sheet', async () => {
    mockSheets.reset();

    const dryRes = await api('/attendance', {
      method: 'POST',
      token: 'test:2105201@kiit.ac.in',
      body: {
        date: '2026-11-10',
        type: 'domain',
        scope: 'web-dev',
        dryRun: true,
        records: [
          { roll: '24151001', status: 'P' },
          { roll: '24151002', status: 'A' },
          { roll: '24151003', status: 'P' },
          { roll: '24158999', status: 'P' },
        ],
      },
    });

    assert.equal(dryRes.status, 200);
    assert.equal(dryRes.data.dryRun, true);
    // Direct sheet check: row 1 only has 4 columns (no column E added)
    assert.equal(mockSheets.data['Web Development'][0].length, 4);
  });

  it('7. Delegation: grant, use, clock advance expiry, revoke', async () => {
    mockSheets.reset();

    // Lead grants delegation for 2 hours to 24158999 (Alice Delegate, present in Web Dev sheet tab)
    const grantRes = await api('/delegations', {
      method: 'POST',
      token: 'test:2105201@kiit.ac.in',
      body: {
        domain: 'web-dev',
        roll: '24158999',
        hours: 2,
      },
    });
    assert.equal(grantRes.status, 200);
    assert.equal(grantRes.data.ok, true);

    // Delegate signs in as 24158999@kiit.ac.in (NOT in fixtures)
    const delMe = await api('/me', { token: 'test:24158999@kiit.ac.in' });
    assert.equal(delMe.status, 200);
    assert.equal(delMe.data.role, 'delegate');
    assert.equal(delMe.data.domains[0].key, 'web-dev');

    // Delegate can fetch web-dev roster
    const delRoster = await api('/roster?scope=web-dev', { token: 'test:24158999@kiit.ac.in' });
    assert.equal(delRoster.status, 200);

    // Delegate CANNOT fetch another domain
    const delCross = await api('/roster?scope=cloud', { token: 'test:24158999@kiit.ac.in' });
    assert.equal(delCross.status, 403);

    // Delegate CANNOT grant delegation
    const delGrant = await api('/delegations', {
      method: 'POST',
      token: 'test:24158999@kiit.ac.in',
      body: { domain: 'web-dev', roll: '24151001', hours: 1 },
    });
    assert.equal(delGrant.status, 403);

    // Delegate submits domain attendance
    const delPost = await api('/attendance', {
      method: 'POST',
      token: 'test:24158999@kiit.ac.in',
      body: {
        date: '2026-11-10',
        type: 'domain',
        scope: 'web-dev',
        records: [
          { roll: '24151001', status: 'P' },
          { roll: '24151002', status: 'P' },
          { roll: '24151003', status: 'P' },
          { roll: '24158999', status: 'P' },
        ],
      },
    });
    assert.equal(delPost.status, 200);
    assert.equal(mockSheets.data['Web Development'][0][4], '2026-11-10 | domain | 24158999@kiit.ac.in');

    // Advance clock past expiry (3 hours)
    virtualTime = new Date(virtualTime.getTime() + 3 * 60 * 60 * 1000);

    // Delegate access is now expired -> 403
    const expiredRes = await api('/me', { token: 'test:24158999@kiit.ac.in' });
    assert.equal(expiredRes.status, 403);
  });
});
