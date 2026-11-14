# MOM Generator Integration Scripts & Tooling

This directory provides operational diagnostics, dry-run planners, a local testing harness, and end-to-end testing tools for the LeetVerse MOM (Minutes of Meeting) integration.

---

## 🔒 Safety Rules for Test Tooling

1. **TEST Sheet Isolation**: All scripts that write or clear data exclusively use `MOM_TEST_SHEET_ID`.
2. **Production Safeguard**: Scripts will immediately refuse to run if `MOM_TEST_SHEET_ID` is unset or equals `MOM_SHEET_ID`.
3. **Explicit Confirmation**: Every destructive or modifying operation (like resetting test columns) requires an explicit `--yes` flag.
4. **Never Commit Secrets**: Service account JSON files or credentials must NEVER be checked into git.

---

## 📋 Manual Prerequisites

Before using the MOM generator in production or against the test sheet, complete these manual setup steps:

1. **Google Sheets Permissions**:
   - Share **BOTH** the production sheet and a **TEST copy** of it (File → Make a copy) with the service account client email as **Editor**:
     `firebase-adminsdk-fbsvc@leetverse-website.iam.gserviceaccount.com` (or your configured service account email).
2. **Environment Variables**:
   - Set `GOOGLE_APPLICATION_CREDENTIALS` (or `MOM_SHEETS_CREDENTIALS_B64`).
   - Set `MOM_SHEET_ID` to your production spreadsheet ID.
   - Set `MOM_TEST_SHEET_ID` to your test spreadsheet copy ID.
3. **Firebase Authentication Settings**:
   - In Firebase Console → Authentication → Settings → Authorized domains:
   - Add the frontend origin/subdomain (e.g. `mom.leetverse.in`, `localhost`, etc.).
4. **Firestore Data Sanity**:
   - Check and fix placeholder rolls in Firestore (`00000000`, `0000000`, `N/A`) for active student members.
5. **Sheet Polish (Optional Hand Polish)**:
   - In both spreadsheets:
     - Freeze row 1 and columns A–D (View → Freeze → 1 row, 4 columns).
     - Format row 1 with Text Wrapping → Wrap.
     - Add conditional formatting on columns E:Z (or whole sheet): Text is exactly `P` → Light green background; Text is exactly `A` → Light red background.

---

## 🛠 Available NPM Scripts

Add these to your `package.json` scripts:

```json
"mom:check-sheet": "tsx scripts/mom/check-sheet.ts",
"mom:check-members": "tsx scripts/mom/check-members.ts",
"mom:plan": "tsx scripts/mom/plan-dry-run.ts",
"mom:serve-harness": "tsx scripts/mom/serve-harness.ts",
"mom:e2e": "tsx scripts/mom/e2e.ts",
"mom:reset-test-sheet": "tsx scripts/mom/reset-test-sheet.ts"
```

### 1. Diagnostic: Check Google Sheet
Inspects tab structure, validates headers, checks fixed columns A–D, verifies next target column, and detects duplicate/multi-tab members.
```bash
# Read and diagnose test sheet (default)
npm run mom:check-sheet

# Read and diagnose production sheet
npm run mom:check-sheet -- --sheet=prod
```

### 2. Diagnostic: Check Firestore Members
Lists active members, evaluates derived roles (`executive`, `lead`, `none`, `fic`), identifies placeholder rolls, and optionally simulates token email resolution.
```bash
# List member counts and role breakdown
npm run mom:check-members

# Test email resolution for a specific user
npm run mom:check-members -- --email=2105201@kiit.ac.in
```

### 3. Dry-Run Write Planner
Simulates an attendance write for any domain or general meeting, computes exact column letters, generates JSON requests for `batchUpdate`, and **makes ZERO writes**.
```bash
npm run mom:plan -- --domain=web-dev --type=domain --date=2026-11-10 --email=lead@kiit.ac.in --random
```

### 4. Local Test Harness (Port 4010)
Starts an isolated test server using the real MOM router, mock token verifier (`test:<email>`), fixture members, and virtual clock endpoints.
```bash
npm run mom:serve-harness
```
- Advance clock: `POST http://localhost:4010/__harness/advance-clock` with body `{"minutes": 60}`
- Reset clock: `POST http://localhost:4010/__harness/reset-clock`

### 5. Reset Test Sheet (Clears Columns E Onward)
Safely clears attendance cells on all 9 domain tabs in the test spreadsheet copy. Requires `--yes`.
```bash
npm run mom:reset-test-sheet -- --yes
```

### 6. Automated E2E Scenarios
Runs complete end-to-end verification covering authentication, role scopes, cross-tab membership, dry-run, conflict handling, and delegation flows:
```bash
npm run mom:e2e
```

