import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';
import { GoogleSheetsClient } from '../../src/mom/sheetsClient';
import { TAB_NAMES, MOM_CONFIG } from '../../src/mom/config';

async function main() {
  const args = process.argv.slice(2);
  const hasYes = args.includes('--yes');

  const testSheetId = process.env.MOM_TEST_SHEET_ID;
  const prodSheetId = process.env.MOM_SHEET_ID;

  // SAFETY CHECKS
  if (!testSheetId) {
    console.error('❌ SAFETY ABORT: MOM_TEST_SHEET_ID is not defined in environment variables.');
    process.exit(1);
  }

  if (prodSheetId && testSheetId === prodSheetId) {
    console.error('❌ CRITICAL SAFETY ABORT: MOM_TEST_SHEET_ID matches MOM_SHEET_ID! Cannot reset production sheet.');
    process.exit(1);
  }

  const sheetsApi = google.sheets({
    version: 'v4',
    auth: new google.auth.GoogleAuth({ scopes: MOM_CONFIG.SHEETS_SCOPES }),
  });

  let spreadsheet: any;
  try {
    const res = await sheetsApi.spreadsheets.get({ spreadsheetId: testSheetId });
    spreadsheet = res.data;
  } catch (err: any) {
    console.error(`❌ Failed to connect to Google Sheets API for test sheet:`, err.message);
    process.exit(1);
  }

  const title = spreadsheet.properties?.title || 'Unknown Title';
  console.log(`\n============================================================`);
  console.log(`🧹 RESET TEST SHEET UTILITY`);
  console.log(`Spreadsheet Title: "${title}"`);
  console.log(`Spreadsheet ID: ${testSheetId}`);
  console.log(`============================================================\n`);

  if (!hasYes) {
    console.error(`⚠️  CONFIRMATION REQUIRED:`);
    console.error(`This script will permanently clear all attendance columns (column E onward) in all 9 domain tabs of the test sheet.`);
    console.error(`To proceed, run with '--yes':`);
    console.error(`   npm run mom:reset-test-sheet -- --yes\n`);
    process.exit(1);
  }

  console.log(`Proceeding with reset...`);

  const client = new GoogleSheetsClient();
  const metaMap = await client.getSpreadsheetMetadata(testSheetId);
  const requests: any[] = [];

  for (const [key, tabTitle] of Object.entries(TAB_NAMES)) {
    const meta = metaMap[tabTitle];
    if (!meta) {
      console.warn(`⚠️  Tab "${tabTitle}" not found in sheet metadata, skipping.`);
      continue;
    }

    // Clear from column E (index 4) onward, row 0 to rowCount
    requests.push({
      updateCells: {
        range: {
          sheetId: meta.sheetId,
          startRowIndex: 0,
          endRowIndex: meta.rowCount,
          startColumnIndex: 4,
          endColumnIndex: meta.columnCount,
        },
        fields: 'userEnteredValue',
      },
    });

    console.log(`   Prepared clear request for tab "${tabTitle}" (cols E..${meta.columnCount})`);
  }

  if (requests.length > 0) {
    await client.batchUpdate(testSheetId, requests);
    console.log(`\n✅ Successfully cleared all attendance columns on ${requests.length} domain tabs.`);
  } else {
    console.log(`\nℹ️  No matching tabs to clear.`);
  }
}

main().catch((err) => {
  console.error('Fatal error in reset-test-sheet:', err);
  process.exit(1);
});

