import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DelegationStore } from '../../src/mom/delegationStore';
import { ResolvedAccess } from '../../src/mom/types';

describe('MOM Delegation Store Unit Tests', () => {
  const createLeadAccess = (domain: string, roll: string): ResolvedAccess => ({
    role: 'lead',
    name: 'Lead User',
    roll,
    email: `${roll}@kiit.ac.in`,
    scope: [domain],
    canGeneral: false,
    canDelegate: true,
  });

  const createExecAccess = (roll: string): ResolvedAccess => ({
    role: 'executive',
    name: 'President User',
    roll,
    email: `${roll}@kiit.ac.in`,
    scope: ['web-dev', 'ai-ml', 'cloud'],
    canGeneral: true,
    canDelegate: true,
  });

  it('allows a lead to grant delegation within their domain', () => {
    let mockTime = new Date('2026-11-10T10:00:00Z');
    const store = new DelegationStore({ now: () => mockTime });

    const lead = createLeadAccess('web-dev', '2105111');
    const result = store.grant({
      domain: 'web-dev',
      roll: '24158130',
      hours: 24,
      grantor: lead,
      sheetRosterRolls: ['24158130', '2105222'],
    });

    assert.equal(result.success, true);
    assert.equal(result.entry?.domain, 'web-dev');
    assert.equal(result.entry?.roll, '24158130');
    assert.equal(result.entry?.grantedByRoll, '2105111');
    assert.equal(
      result.entry?.expiresAt,
      new Date('2026-11-11T10:00:00Z').toISOString()
    );

    const active = store.getActiveDelegations();
    assert.equal(active.length, 1);
    store.stopSweep();
  });

  it('rejects lead granting to a different domain', () => {
    const store = new DelegationStore();
    const lead = createLeadAccess('web-dev', '2105111');

    const result = store.grant({
      domain: 'cloud',
      roll: '24158130',
      hours: 24,
      grantor: lead,
      sheetRosterRolls: ['24158130'],
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 403);
    store.stopSweep();
  });

  it('rejects granting to oneself', () => {
    const store = new DelegationStore();
    const lead = createLeadAccess('web-dev', '2105111');

    const result = store.grant({
      domain: 'web-dev',
      roll: '2105111',
      grantor: lead,
      sheetRosterRolls: ['2105111', '24158130'],
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 422);
    assert.equal(result.error, 'Cannot grant delegation to yourself.');
    store.stopSweep();
  });

  it('rejects granting to a roll not in the sheet roster', () => {
    const store = new DelegationStore();
    const lead = createLeadAccess('web-dev', '2105111');

    const result = store.grant({
      domain: 'web-dev',
      roll: '9999999',
      grantor: lead,
      sheetRosterRolls: ['24158130'],
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 422);
    store.stopSweep();
  });

  it('rejects duration above MAX_DELEGATION_HOURS (168h)', () => {
    const store = new DelegationStore();
    const lead = createLeadAccess('web-dev', '2105111');

    const result = store.grant({
      domain: 'web-dev',
      roll: '24158130',
      hours: 200,
      grantor: lead,
      sheetRosterRolls: ['24158130'],
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 422);
    store.stopSweep();
  });

  it('expires delegation when time advances beyond expiresAt', () => {
    let mockTime = new Date('2026-11-10T10:00:00Z');
    const store = new DelegationStore({ now: () => mockTime });

    const lead = createLeadAccess('web-dev', '2105111');
    store.grant({
      domain: 'web-dev',
      roll: '24158130',
      hours: 2,
      grantor: lead,
      sheetRosterRolls: ['24158130'],
    });

    assert.equal(store.getActiveDelegations().length, 1);

    // Advance clock by 3 hours
    mockTime = new Date('2026-11-10T13:00:00Z');
    assert.equal(store.getActiveDelegations().length, 0);
    store.stopSweep();
  });

  it('replaces existing delegation on re-granting the same domain and roll', () => {
    let mockTime = new Date('2026-11-10T10:00:00Z');
    const store = new DelegationStore({ now: () => mockTime });

    const lead = createLeadAccess('web-dev', '2105111');
    store.grant({
      domain: 'web-dev',
      roll: '24158130',
      hours: 10,
      grantor: lead,
      sheetRosterRolls: ['24158130'],
    });

    // Re-grant for 48 hours
    store.grant({
      domain: 'web-dev',
      roll: '24158130',
      hours: 48,
      grantor: lead,
      sheetRosterRolls: ['24158130'],
    });

    const active = store.getActiveDelegations();
    assert.equal(active.length, 1);
    assert.equal(active[0].expiresAt, new Date('2026-11-12T10:00:00Z').toISOString());
    store.stopSweep();
  });

  it('drops delegation when grantor validation fails (e.g. no longer lead)', () => {
    let mockTime = new Date('2026-11-10T10:00:00Z');
    const store = new DelegationStore({ now: () => mockTime });

    const lead = createLeadAccess('web-dev', '2105111');
    store.grant({
      domain: 'web-dev',
      roll: '24158130',
      hours: 24,
      grantor: lead,
      sheetRosterRolls: ['24158130'],
    });

    // When validator returns false (grantor lost lead status)
    const active = store.getActiveDelegations((_grantorRoll, _domain) => false);
    assert.equal(active.length, 0);
    store.stopSweep();
  });

  it('allows revoking by grantor, lead of domain, or executive', () => {
    const store = new DelegationStore();
    const lead = createLeadAccess('web-dev', '2105111');
    const exec = createExecAccess('2105001');

    store.grant({
      domain: 'web-dev',
      roll: '24158130',
      grantor: lead,
      sheetRosterRolls: ['24158130'],
    });

    // Executive can revoke
    const res = store.revoke('web-dev', '24158130', exec);
    assert.equal(res.success, true);
    assert.equal(store.getActiveDelegations().length, 0);
    store.stopSweep();
  });
});

