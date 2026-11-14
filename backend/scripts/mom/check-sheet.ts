import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';
import { GoogleSheetsClient } from '../../src/mom/sheetsClient';
import { TAB_NAMES, DOMAIN_KEYS, MOM_CONFIG } from '../../src/mom/config';
import { validateTab, colLetter, parseHeader } from '../../src/mom/pure';

async function main() {
  const args = process.argv.slice(2);
  const sheetArg = args.find((a) => a.startsWith('--sheet='))?.split('=')[1] || 'test';

  const sheetId = sheetArg === 'prod' ? process.env.MOM_SHEET_ID : process.env.MOM_TEST_SHEET_ID;

  if (!sheetId) {
    console.error(`❌ Error: Spreadsheet ID for '--sheet=${sheetArg}' is not set in environment (MOM_${sheetArg.toUpperCase()}_SHEET_ID).`);
    process.exit(1);
  }

  console.log(`\n============================================================`);
  console.log(`📋 MOM Google Sheet Diagnostic (${sheetArg.toUpperCase()} SHEET)`);
  console.log(`Spreadsheet ID: ${sheetId}`);
  console.log(`============================================================\n`);

  const client = new GoogleSheetsClient();
  const sheetsApi = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ scopes: MOM_CONFIG.SHEETS_SCOPES }) });

  let spreadsheet: any;
  try {
    const res = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
    spreadsheet = res.data;
  } catch (err: any) {
    console.error(`❌ Failed to connect to Google Sheets API:`, err.message);
    process.exit(1);
  }

  console.log(`📑 Title: "${spreadsheet.properties?.title}"`);
  console.log(`🌐 Locale: ${spreadsheet.properties?.locale || 'N/A'}`);
  console.log(`🕒 TimeZone: ${spreadsheet.properties?.timeZone || 'N/A'}\n`);

  // Compare Tab Titles
  const existingTabs = (spreadsheet.sheets || []).map((s: any) => s.properties?.title || '');
  const requiredTitles = Object.values(TAB_NAMES);

  console.log(`--- TAB COMPARISON ---`);
  const missingTabs = requiredTitles.filter((r) => !existingTabs.includes(r));
  const whitespaceIssues = requiredTitles.filter((r) =>
    existingTabs.some((e: string) => e !== r && e.trim() === r.trim())
  );
  const extraTabs = existingTabs.filter((e: string) => !requiredTitles.includes(e));

  if (missingTabs.length === 0) {
    console.log(`✅ All ${requiredTitles.length} required domain tabs are PRESENT.`);
  } else {
    console.log(`❌ MISSING TABS (${missingTabs.length}):`, missingTabs);
  }

  if (whitespaceIssues.length > 0) {
    console.log(`⚠️  WHITESPACE MISMATCHES DETECTED:`, whitespaceIssues);
  }

  if (extraTabs.length > 0) {
    console.log(`ℹ️  Extra / Unused Tabs:`, extraTabs);
  }
  console.log(``);

  // Read all available required tabs
  const availableTitles = requiredTitles.filter((t) => existingTabs.includes(t));
  const tabValues = await client.getTabValues(sheetId, availableTitles);
  const metaMap = await client.getSpreadsheetMetadata(sheetId);

  const rollOccurrences = new Map<string, { name: string; tabs: string[] }>();

  console.log(`--- TAB-BY-TAB DETAILS ---`);
  for (const domainKey of DOMAIN_KEYS) {
    const title = TAB_NAMES[domainKey];
    console.log(`\n🔹 Domain: [${domainKey}] -> Tab: "${title}"`);

    const meta = metaMap[title];
    if (!meta) {
      console.log(`   ❌ Tab not found in metadata!`);
      continue;
    }

    console.log(`   Grid: ${meta.rowCount} rows x ${meta.columnCount} cols (sheetId: ${meta.sheetId})`);

    const rows = tabValues[title] || [];
    if (rows.length === 0) {
      console.log(`   ⚠️  Tab is empty!`);
      continue;
    }

    const val = validateTab(title, rows, meta.sheetId, meta.columnCount, meta.rowCount);

    // Row 1 headers
    const row1 = rows[0] || [];
    console.log(`   Row 1 Headers (A-D): [${row1.slice(0, 4).map((c) => `"${c ?? ''}"`).join(', ')}]`);
    console.log(`   Roster Count: ${val.roster.length} members`);
    console.log(`   Last filled col: index ${val.lastFilledCol} (${colLetter(val.lastFilledCol)})`);
    console.log(`   Next target col: index ${val.nextCol} (${colLetter(val.nextCol)})`);

    if (val.problems.length > 0) {
      console.log(`   ⚠️  Problems detected (${val.problems.length}):`);
      val.problems.forEach((p) => {
        console.log(`      - Row ${p.row || 'N/A'}: ${p.message}`);
      });
    } else {
      console.log(`   ✅ Tab structure is valid.`);
    }

    // Check invalid attendance headers
    for (let c = 4; c < row1.length; c++) {
      const headerCell = row1[c];
      if (headerCell && String(headerCell).trim() !== '') {
        const parsed = parseHeader(String(headerCell));
        if (!parsed) {
          console.log(`   ⚠️  Non-standard header at col ${colLetter(c)}: "${headerCell}"`);
        }
      }
    }

    console.log(`   Recorded Meetings: ${val.existing.length}`);
    val.existing.forEach((e) => {
      console.log(`      • ${e.date} (${e.type}) by ${e.email || 'N/A'}`);
    });

    // Track cross-tab duplicates
    for (const m of val.roster) {
      const occ = rollOccurrences.get(m.roll);
      if (occ) {
        occ.tabs.push(title);
      } else {
        rollOccurrences.set(m.roll, { name: m.name, tabs: [title] });
      }
    }
  }

  // Cross-tab duplicates
  console.log(`\n--- CROSS-TAB DUPLICATE MEMBERS ---`);
  const multiTabMembers = Array.from(rollOccurrences.entries()).filter(
    ([, v]) => v.tabs.length > 1
  );

  if (multiTabMembers.length === 0) {
    console.log(`✅ No members appear in multiple domain tabs.`);
  } else {
    console.log(`ℹ️  ${multiTabMembers.length} member(s) appear in multiple domain tabs:`);
    multiTabMembers.forEach(([roll, data]) => {
      console.log(`   • Roll: ${roll} (${data.name}) -> Tabs: [${data.tabs.join(', ')}]`);
    });
  }
}

main().catch((err) => {
  console.error('Fatal error in check-sheet:', err);
  process.exit(1);
});

