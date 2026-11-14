import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollFromEmail,
  isPlaceholderRoll,
  roleOf,
  colLetter,
  buildHeader,
  parseHeader,
  findNextColumn,
  validateDate,
  validateTab,
  planAttendanceWrite,
} from '../../src/mom/pure';
import { Member } from '../../src/mom/types';

describe('MOM Pure Functions Unit Tests', () => {
  describe('rollFromEmail', () => {
    it('extracts 7 and 8 digit rolls from valid KIIT emails', () => {
      assert.equal(rollFromEmail('24158130@kiit.ac.in'), '24158130');
      assert.equal(rollFromEmail('2105123@kiit.ac.in'), '2105123');
      assert.equal(rollFromEmail('  24158130@KIIT.AC.IN '), '24158130');
    });

    it('returns null for non-roll emails or external domains', () => {
      assert.equal(rollFromEmail('president@leetverse.in'), null);
      assert.equal(rollFromEmail('john.doe@kiit.ac.in'), null);
      assert.equal(rollFromEmail('123@kiit.ac.in'), null); // too short
      assert.equal(rollFromEmail('123456789@kiit.ac.in'), null); // too long
      assert.equal(rollFromEmail(''), null);
      assert.equal(rollFromEmail(null as any), null);
    });
  });

  describe('isPlaceholderRoll', () => {
    it('identifies placeholder and invalid rolls', () => {
      assert.equal(isPlaceholderRoll('00000000'), true);
      assert.equal(isPlaceholderRoll('0000000'), true);
      assert.equal(isPlaceholderRoll('0'), true);
      assert.equal(isPlaceholderRoll('N/A'), true);
      assert.equal(isPlaceholderRoll('n/a'), true);
      assert.equal(isPlaceholderRoll(''), true);
      assert.equal(isPlaceholderRoll('ABC1234'), true);
      assert.equal(isPlaceholderRoll('24158130'), false);
      assert.equal(isPlaceholderRoll('2105123'), false);
    });
  });

  describe('roleOf', () => {
    it('resolves AI/ML Lead to lead', () => {
      const member: Member = {
        name: 'Lead User',
        rollNo: '2105111',
        position: 'AI/ML Lead',
        domain: 'ai-ml',
        status: 'active',
      };
      assert.equal(roleOf(member), 'lead');
    });

    it('resolves APP DEV Lead to lead', () => {
      const member: Member = {
        name: 'App Dev Lead',
        rollNo: '2105222',
        position: 'APP DEV Lead',
        domain: 'app-dev',
        status: 'active',
      };
      assert.equal(roleOf(member), 'lead');
    });

    it('resolves Asst. Lead to none', () => {
      const member: Member = {
        name: 'Assistant Lead',
        rollNo: '2105333',
        position: 'Asst. Lead',
        domain: 'marketing-pr',
        status: 'active',
      };
      assert.equal(roleOf(member), 'none');
    });

    it('resolves Assistant Lead to none', () => {
      const member: Member = {
        name: 'Assistant Lead 2',
        rollNo: '2105334',
        position: 'Assistant Lead',
        domain: 'web-dev',
        status: 'active',
      };
      assert.equal(roleOf(member), 'none');
    });

    it('resolves Vice President in executive domain to executive', () => {
      const member: Member = {
        name: 'VP User',
        rollNo: '2105444',
        position: 'Vice President',
        domain: 'executive',
        status: 'active',
      };
      assert.equal(roleOf(member), 'executive');
    });

    it('resolves General Secretary in executive domain to executive', () => {
      const member: Member = {
        name: 'GenSec User',
        rollNo: '2105555',
        position: 'General Secretary',
        domain: 'executive',
        status: 'active',
      };
      assert.equal(roleOf(member), 'executive');
    });

    it('resolves Faculty-in-Charge in fic domain to none (denied completely)', () => {
      const member: Member = {
        name: 'FIC Faculty',
        rollNo: 'N/A',
        position: 'Faculty-in-Charge',
        domain: 'fic',
        status: 'active',
      };
      assert.equal(roleOf(member), 'none');
    });

    it('resolves regular Member to none', () => {
      const member: Member = {
        name: 'Normal Member',
        rollNo: '24158130',
        position: 'Member',
        domain: 'web-dev',
        status: 'active',
      };
      assert.equal(roleOf(member), 'none');
    });

    it('returns none for inactive members', () => {
      const member: Member = {
        name: 'Inactive VP',
        rollNo: '2105001',
        position: 'Vice President',
        domain: 'executive',
        status: 'inactive',
      };
      assert.equal(roleOf(member), 'none');
    });
  });

  describe('colLetter', () => {
    it('converts indices correctly per specification', () => {
      assert.equal(colLetter(0), 'A');
      assert.equal(colLetter(25), 'Z');
      assert.equal(colLetter(26), 'AA');
      assert.equal(colLetter(27), 'AB');
      assert.equal(colLetter(51), 'AZ');
      assert.equal(colLetter(52), 'BA');
      assert.equal(colLetter(701), 'ZZ');
      assert.equal(colLetter(702), 'AAA');
    });
  });

  describe('buildHeader and parseHeader', () => {
    it('builds and parses header correctly', () => {
      const built = buildHeader('2026-11-06', 'domain', '24158130@KIIT.AC.IN');
      assert.equal(built, '2026-11-06 | domain | 24158130@kiit.ac.in');

      const parsed = parseHeader(built);
      assert.deepEqual(parsed, {
        date: '2026-11-06',
        type: 'domain',
        email: '24158130@kiit.ac.in',
      });
    });

    it('returns null for invalid header strings', () => {
      assert.equal(parseHeader('Invalid Header'), null);
      assert.equal(parseHeader('2026-11-06 | custom | user@kiit.ac.in'), null);
      assert.equal(parseHeader('2026-99-99 | domain | user@kiit.ac.in'), null);
      assert.equal(parseHeader('2026-11-06 | domain | invalidemail'), null);
    });
  });

  describe('findNextColumn', () => {
    it('handles empty header row (returns column E / index 4)', () => {
      const res = findNextColumn([]);
      assert.equal(res.nextCol, 4);
      assert.equal(res.colLetter, 'E');
    });

    it('handles headers only in A-D (returns column E / index 4)', () => {
      const res = findNextColumn(['NAME', 'ROLL NO', 'Email ID', 'PHONE']);
      assert.equal(res.nextCol, 4);
      assert.equal(res.colLetter, 'E');
    });

    it('handles a gap in the middle (uses rightmost non-empty cell)', () => {
      const row1 = ['NAME', 'ROLL NO', 'Email ID', 'PHONE', '2026-11-01 | domain | a@kiit.ac.in', '', '2026-11-03 | domain | b@kiit.ac.in'];
      const res = findNextColumn(row1);
      assert.equal(res.lastFilledCol, 6);
      assert.equal(res.nextCol, 7);
      assert.equal(res.colLetter, 'H');
    });

    it('handles junk at the far right defensively', () => {
      const row1 = ['NAME', 'ROLL NO', 'Email ID', 'PHONE', '2026-11-01 | domain | a@kiit.ac.in', 'Notes'];
      const res = findNextColumn(row1);
      assert.equal(res.lastFilledCol, 5);
      assert.equal(res.nextCol, 6);
      assert.equal(res.colLetter, 'G');
    });
  });

  describe('validateDate', () => {
    it('validates dates in IST timezone', () => {
      const fakeNow = new Date('2026-11-10T12:00:00Z');
      // Today in IST is 2026-11-10

      // Valid current date
      assert.equal(validateDate('2026-11-10', false, fakeNow).valid, true);
      // Valid tomorrow (within 1 future day)
      assert.equal(validateDate('2026-11-11', false, fakeNow).valid, true);
      // Invalid 2 days in future
      assert.equal(validateDate('2026-11-12', false, fakeNow).valid, false);

      // Past date for non-exec (within 14 days)
      assert.equal(validateDate('2026-10-28', false, fakeNow).valid, true);
      // Past date for non-exec (> 14 days) -> invalid
      assert.equal(validateDate('2026-10-20', false, fakeNow).valid, false);

      // Past date for executive (> 14 days) -> valid
      assert.equal(validateDate('2026-01-01', true, fakeNow).valid, true);

      // Non-existent calendar date
      assert.equal(validateDate('2026-02-30', false, fakeNow).valid, false);
      assert.equal(validateDate('not-a-date', false, fakeNow).valid, false);
    });
  });

  describe('planAttendanceWrite', () => {
    const dummyValidation = {
      valid: true,
      tabTitle: 'Web Development',
      sheetId: 101,
      columnCount: 26,
      rowCount: 100,
      roster: [
        { roll: '2105001', name: 'Alice' },
        { roll: '2105002', name: 'Bob' },
      ],
      rosterRows: [
        { rowNumber: 2, roll: '2105001', name: 'Alice' },
        { rowNumber: 3, roll: '2105002', name: 'Bob' },
      ],
      problems: [],
      lastFilledCol: 3,
      nextCol: 4,
      existing: [
        {
          date: '2026-11-01',
          type: 'domain' as const,
          email: 'lead@kiit.ac.in',
        },
      ],
    };

    it('creates a clean plan for valid records', () => {
      const plan = planAttendanceWrite({
        date: '2026-11-06',
        type: 'domain',
        email: 'lead@kiit.ac.in',
        scopeKeys: ['web-dev'],
        records: [
          { roll: '2105001', status: 'P' },
          { roll: '2105002', status: 'A' },
        ],
        tabValidations: {
          'web-dev': dummyValidation,
        },
      });

      assert.equal(plan.problems.length, 0);
      assert.equal(plan.tabs.length, 1);
      assert.equal(plan.tabs[0].duplicateStatus, 'ok');
      assert.equal(plan.tabs[0].nextCol, 4);
      assert.equal(plan.tabs[0].colLetter, 'E');
      assert.equal(plan.tabs[0].presentCount, 1);
      assert.equal(plan.tabs[0].absentCount, 1);
      assert.deepEqual(plan.tabs[0].cells, [
        '2026-11-06 | domain | lead@kiit.ac.in',
        'P',
        'A',
      ]);
    });

    it('detects already_recorded when same date/type/email exists', () => {
      const plan = planAttendanceWrite({
        date: '2026-11-01',
        type: 'domain',
        email: 'lead@kiit.ac.in',
        scopeKeys: ['web-dev'],
        records: [
          { roll: '2105001', status: 'P' },
          { roll: '2105002', status: 'A' },
        ],
        tabValidations: {
          'web-dev': dummyValidation,
        },
      });

      assert.equal(plan.problems.length, 0);
      assert.equal(plan.tabs[0].duplicateStatus, 'already_recorded');
    });

    it('detects conflict when same date/type but different email exists', () => {
      const plan = planAttendanceWrite({
        date: '2026-11-01',
        type: 'domain',
        email: 'other@kiit.ac.in',
        scopeKeys: ['web-dev'],
        records: [
          { roll: '2105001', status: 'P' },
          { roll: '2105002', status: 'A' },
        ],
        tabValidations: {
          'web-dev': dummyValidation,
        },
      });

      assert.equal(plan.hasConflict, true);
      assert.equal(plan.tabs[0].duplicateStatus, 'conflict');
      assert.equal(plan.problems.some((p) => p.code === 'CONFLICT'), true);
    });

    it('flags missing and unknown rolls', () => {
      const plan = planAttendanceWrite({
        date: '2026-11-06',
        type: 'domain',
        email: 'lead@kiit.ac.in',
        scopeKeys: ['web-dev'],
        records: [
          { roll: '2105001', status: 'P' },
          { roll: '9999999', status: 'A' }, // Unknown roll, missing 2105002
        ],
        tabValidations: {
          'web-dev': dummyValidation,
        },
      });

      assert.equal(plan.problems.some((p) => p.message.includes('Missing attendance record')), true);
      assert.equal(plan.problems.some((p) => p.message.includes('Unknown roll number')), true);
    });
  });
});

