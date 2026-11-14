import dotenv from 'dotenv';
dotenv.config();

import { defaultMembersLoader } from '../../src/mom/membersLoader';
import { roleOf, resolveAccess, isPlaceholderRoll } from '../../src/mom/pure';
import { GoogleSheetsClient } from '../../src/mom/sheetsClient';
import { TAB_NAMES } from '../../src/mom/config';

async function main() {
  const args = process.argv.slice(2);
  const emailArg = args.find((a) => a.startsWith('--email='))?.split('=')[1];

  console.log(`\n============================================================`);
  console.log(`👥 MOM Firestore Members Diagnostic`);
  console.log(`============================================================\n`);

  let members = [];
  try {
    members = await defaultMembersLoader.getMembers();
  } catch (err: any) {
    console.error(`❌ Failed to read members from Firestore:`, err.message);
    process.exit(1);
  }

  console.log(`📊 Total Active Members Loaded: ${members.length}\n`);

  // Count roles
  let execCount = 0;
  let leadCount = 0;
  let noneCount = 0;
  let ficCount = 0;

  const placeholderRolls: string[] = [];
  const seenRolls = new Map<string, string[]>();

  for (const m of members) {
    const role = roleOf(m);
    if (role === 'executive') execCount++;
    else if (role === 'lead') leadCount++;
    else if (m.domain.trim().toLowerCase() === 'fic') ficCount++;
    else noneCount++;

    if (isPlaceholderRoll(m.rollNo)) {
      placeholderRolls.push(`${m.name} (${m.rollNo}) [${m.domain}]`);
    } else {
      const roll = m.rollNo.trim();
      const existing = seenRolls.get(roll);
      if (existing) {
        existing.push(`${m.name} (${m.domain})`);
      } else {
        seenRolls.set(roll, [`${m.name} (${m.domain})`]);
      }
    }
  }

  console.log(`--- ROLE DISTRIBUTION ---`);
  console.log(`👑 Executives: ${execCount}`);
  console.log(`⭐ Leads: ${leadCount}`);
  console.log(`🏛️  Faculty-in-Charge: ${ficCount}`);
  console.log(`👤 General / Other: ${noneCount}\n`);

  if (placeholderRolls.length > 0) {
    console.log(`⚠️  PLACEHOLDER ROLLS DETECTED (${placeholderRolls.length}):`);
    placeholderRolls.forEach((p) => console.log(`   - ${p}`));
    console.log(``);
  } else {
    console.log(`✅ No placeholder rolls among active members.\n`);
  }

  const duplicates = Array.from(seenRolls.entries()).filter(([, list]) => list.length > 1);
  if (duplicates.length > 0) {
    console.log(`⚠️  DUPLICATE ROLLS IN FIRESTORE (${duplicates.length}):`);
    duplicates.forEach(([roll, list]) => {
      console.log(`   • Roll ${roll}: ${list.join('; ')}`);
    });
    console.log(``);
  } else {
    console.log(`✅ No duplicate roll numbers found in Firestore.\n`);
  }

  // Cross check leads against their domain tab if sheet ID available
  const sheetId = process.env.MOM_TEST_SHEET_ID || process.env.MOM_SHEET_ID;
  if (sheetId) {
    try {
      console.log(`--- CROSS-CHECKING LEADS AGAINST SHEET ROSTERS ---`);
      const client = new GoogleSheetsClient();
      const leads = members.filter((m) => roleOf(m) === 'lead');

      const domainTitles = Array.from(new Set(leads.map((l) => TAB_NAMES[l.domain]).filter(Boolean)));
      const tabValues = await client.getTabValues(sheetId, domainTitles);

      for (const lead of leads) {
        const title = TAB_NAMES[lead.domain];
        if (!title) continue;
        const rows = tabValues[title] || [];
        const rollsInTab = rows.slice(1).map((r) => String(r[1] ?? '').trim());

        if (rollsInTab.includes(lead.rollNo.trim())) {
          console.log(`   ✅ Lead '${lead.name}' (${lead.rollNo}) found in tab "${title}"`);
        } else {
          console.log(`   ⚠️  WARNING: Lead '${lead.name}' (${lead.rollNo}) is ABSENT in tab "${title}"!`);
        }
      }
      console.log(``);
    } catch (err: any) {
      console.log(`   ℹ️  Skipped sheet cross-check: ${err.message}\n`);
    }
  }

  // If --email provided, show resolution
  if (emailArg) {
    console.log(`--- EMAIL RESOLUTION TEST: ${emailArg} ---`);
    const resolved = resolveAccess({
      user: {
        uid: 'test-diagnostic-uid',
        email: emailArg,
        emailVerified: true,
      },
      members,
    });

    console.log(`   Resolved Role: ${resolved.role}`);
    console.log(`   Effective Name: ${resolved.name}`);
    console.log(`   Effective Roll: ${resolved.roll || 'N/A'}`);
    console.log(`   Can General: ${resolved.canGeneral}`);
    console.log(`   Can Delegate: ${resolved.canDelegate}`);
    console.log(`   Authorized Scope: [${resolved.scope.join(', ')}]`);
  }
}

main().catch((err) => {
  console.error('Fatal error in check-members:', err);
  process.exit(1);
});

