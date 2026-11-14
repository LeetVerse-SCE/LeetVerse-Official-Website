import dotenv from 'dotenv';
dotenv.config();

import { GoogleSheetsClient } from '../../src/mom/sheetsClient';
import { TAB_NAMES } from '../../src/mom/config';
import { validateTab, planAttendanceWrite } from '../../src/mom/pure';
import { AttendanceRecordInput, TabStructureValidation } from '../../src/mom/types';

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string, fallback?: string) => {
    const val = args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
    return val !== undefined ? val : fallback;
  };

  const domain = getArg('domain', 'web-dev')!;
  const type = (getArg('type', 'domain') as 'domain' | 'general')!;
  const date = getArg('date', new Date().toISOString().split('T')[0])!;
  const email = getArg('email', 'lead@kiit.ac.in')!;
  const presentArg = getArg('present');
  const isRandom = args.includes('--random');

  const sheetId = process.env.MOM_TEST_SHEET_ID || process.env.MOM_SHEET_ID;
  if (!sheetId) {
    console.error('❌ Error: MOM_TEST_SHEET_ID or MOM_SHEET_ID must be set in environment.');
    process.exit(1);
  }

  const client = new GoogleSheetsClient();
  const targetDomainKeys = domain === 'ALL' ? Object.keys(TAB_NAMES) : [domain];
  const targetTabTitles = targetDomainKeys.map((k) => TAB_NAMES[k]);

  console.log(`\n============================================================`);
  console.log(`🔍 MOM Attendance Plan (DRY RUN - ZERO WRITES)`);
  console.log(`Date: ${date} | Type: ${type} | Email: ${email}`);
  console.log(`Scope: ${domain} (${targetTabTitles.join(', ')})`);
  console.log(`============================================================\n`);

  // Read target tabs
  const tabValues = await client.getTabValues(sheetId, targetTabTitles);
  const metaMap = await client.getSpreadsheetMetadata(sheetId);

  const tabValidations: Record<string, TabStructureValidation> = {};
  const allRolls: string[] = [];

  for (const dKey of targetDomainKeys) {
    const title = TAB_NAMES[dKey];
    const rows = tabValues[title] || [];
    const meta = metaMap[title] || { sheetId: 0, columnCount: 26, rowCount: 1000 };
    const val = validateTab(title, rows, meta.sheetId, meta.columnCount, meta.rowCount);
    tabValidations[dKey] = val;

    for (const m of val.roster) {
      if (!allRolls.includes(m.roll)) {
        allRolls.push(m.roll);
      }
    }
  }

  // Build records
  const presentRolls = presentArg ? presentArg.split(',').map((s) => s.trim()) : [];
  const records: AttendanceRecordInput[] = allRolls.map((roll) => {
    let status: 'P' | 'A' = 'A';
    if (isRandom) {
      status = Math.random() > 0.5 ? 'P' : 'A';
    } else if (presentRolls.includes(roll)) {
      status = 'P';
    }
    return { roll, status };
  });

  const plan = planAttendanceWrite({
    date,
    type,
    email,
    scopeKeys: targetDomainKeys,
    records,
    tabValidations,
  });

  console.log(`--- PLAN SUMMARY ---`);
  console.log(`Problems: ${plan.problems.length}`);
  if (plan.problems.length > 0) {
    plan.problems.forEach((p) => console.log(`   ❌ [${p.code || 'ERROR'}] ${p.tab}: ${p.message}`));
  }

  console.log(`Has Conflict: ${plan.hasConflict}`);
  console.log(`Has Structure Problem: ${plan.hasStructureProblem}`);
  console.log(`Planned Tabs: ${plan.tabs.length}\n`);

  // Construct hypothetical batchUpdate requests
  const requests: any[] = [];
  for (const tab of plan.tabs) {
    console.log(`🔹 Tab: "${tab.tabTitle}"`);
    console.log(`   Target Col: ${tab.colLetter} (index ${tab.nextCol})`);
    console.log(`   Header: "${tab.header}"`);
    console.log(`   Present: ${tab.presentCount} | Absent: ${tab.absentCount}`);
    console.log(`   Duplicate Status: ${tab.duplicateStatus}`);
    console.log(`   Needed Column Expansion: +${tab.neededColumns} cols`);
    console.log(`   Needed Row Expansion: +${tab.neededRows} rows\n`);

    if (tab.neededColumns > 0) {
      requests.push({
        appendDimension: {
          sheetId: tab.sheetId,
          dimension: 'COLUMNS',
          length: tab.neededColumns,
        },
      });
    }

    const rowData = tab.cells.map((val) => ({
      values: [{ userEnteredValue: { stringValue: val } }],
    }));

    requests.push({
      updateCells: {
        rows: rowData,
        fields: 'userEnteredValue',
        start: {
          sheetId: tab.sheetId,
          rowIndex: 0,
          columnIndex: tab.nextCol,
        },
      },
    });
  }

  console.log(`--- PLANNED BATCH UPDATE REQUESTS (JSON) ---`);
  console.log(JSON.stringify(requests, null, 2));
}

main().catch((err) => {
  console.error('Fatal error in plan-dry-run:', err);
  process.exit(1);
});

