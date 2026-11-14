import { TAB_NAMES, MOM_CONFIG } from '../config';
import {
  Member,
  MomRole,
  VerifiedUser,
  ResolvedAccess,
  DelegationEntry,
  SheetProblem,
  SheetRosterMember,
  ExistingMeeting,
  TabStructureValidation,
  AttendanceRecordInput,
  AttendanceWritePlan,
  AttendanceWritePlanTab,
} from '../types';

/**
 * Extracts student roll number from KIIT email address.
 * e.g., 24158130@kiit.ac.in -> "24158130"
 */
export function rollFromEmail(
  email: string | null | undefined,
  minDigits = MOM_CONFIG.MIN_ROLL_DIGITS,
  maxDigits = MOM_CONFIG.MAX_ROLL_DIGITS
): string | null {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  const regex = new RegExp(`^(\\d{${minDigits},${maxDigits}})@kiit\\.ac\\.in$`);
  const match = trimmed.match(regex);
  return match ? match[1] : null;
}

/**
 * Checks if a roll number is a placeholder (e.g. all zeros, N/A, non-digits).
 */
export function isPlaceholderRoll(roll: string | null | undefined): boolean {
  if (!roll || typeof roll !== 'string') return true;
  const trimmed = roll.trim();
  if (trimmed === '' || /^0+$/.test(trimmed) || trimmed.toUpperCase() === 'N/A') {
    return true;
  }
  // If it doesn't contain at least one digit or has non-alphanumeric chars
  return !/^\d+$/.test(trimmed);
}

/**
 * Determines a member's role based on their domain and position.
 */
export function roleOf(member: Member | null | undefined): MomRole {
  if (!member) return 'none';
  if (member.status !== 'active') return 'none';

  const primaryDomain = (member.domain || '').trim().toLowerCase();
  if (primaryDomain === 'fic') return 'none';
  if (primaryDomain === 'executive') return 'executive';

  const pos = (member.position || '').trim().toLowerCase();
  const isLead =
    pos.endsWith('lead') &&
    !pos.startsWith('asst') &&
    !pos.startsWith('assistant');

  if (isLead && Object.prototype.hasOwnProperty.call(TAB_NAMES, primaryDomain)) {
    return 'lead';
  }

  return 'none';
}

/**
 * Resolves user access based on verified Firebase token, Firestore members,
 * and in-memory active delegations.
 */
export function resolveAccess(params: {
  user: VerifiedUser;
  members: Member[];
  activeDelegations?: DelegationEntry[];
  now?: Date;
  validateGrantor?: (grantorRoll: string, domain: string) => boolean;
}): ResolvedAccess {
  const { user, members, activeDelegations = [], now = new Date(), validateGrantor } = params;
  const email = (user.email || '').trim().toLowerCase();
  const rollFromUserEmail = rollFromEmail(email);

  // 1. Find member by email or rollNo
  let matchedMember: Member | undefined = members.find(
    (m) => m.email && m.email.trim().toLowerCase() === email
  );

  if (!matchedMember && rollFromUserEmail) {
    matchedMember = members.find(
      (m) =>
        m.rollNo &&
        !isPlaceholderRoll(m.rollNo) &&
        m.rollNo.trim() === rollFromUserEmail
    );
  }

  const effectiveRoll =
    (matchedMember && matchedMember.rollNo && !isPlaceholderRoll(matchedMember.rollNo)
      ? matchedMember.rollNo.trim()
      : null) || rollFromUserEmail;

  // 2. Base role evaluation
  const baseRole = matchedMember ? roleOf(matchedMember) : 'none';
  let finalRole: MomRole = baseRole;
  const scopeSet = new Set<string>();
  let canGeneral = false;
  let canDelegate = false;

  if (baseRole === 'executive') {
    Object.keys(TAB_NAMES).forEach((k) => scopeSet.add(k));
    canGeneral = true;
    canDelegate = true;
  } else if (baseRole === 'lead' && matchedMember) {
    const domainKey = matchedMember.domain.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TAB_NAMES, domainKey)) {
      scopeSet.add(domainKey);
    }
    canGeneral = false;
    canDelegate = true;
  }

  // 3. Delegation lookup
  const delegatedUntil: Record<string, string> = {};
  if (effectiveRoll) {
    const currentTimeStr = now.toISOString();
    for (const del of activeDelegations) {
      if (del.roll === effectiveRoll && del.expiresAt > currentTimeStr) {
        // Re-validate grantor if validator provided
        if (validateGrantor && !validateGrantor(del.grantedByRoll, del.domain)) {
          continue;
        }
        scopeSet.add(del.domain);
        delegatedUntil[del.domain] = del.expiresAt;
      }
    }
  }

  // If user has no base role but has active delegations
  if (finalRole === 'none' && Object.keys(delegatedUntil).length > 0) {
    finalRole = 'delegate';
    canGeneral = false;
    canDelegate = false;
  }

  return {
    role: finalRole,
    member: matchedMember,
    roll: effectiveRoll || undefined,
    name: matchedMember?.name || user.name || effectiveRoll || 'User',
    email,
    scope: Array.from(scopeSet),
    canGeneral,
    canDelegate,
    delegatedUntil: Object.keys(delegatedUntil).length > 0 ? delegatedUntil : undefined,
  };
}

/**
 * Converts 0-indexed column integer to spreadsheet column letter (A, B, ..., Z, AA, AB...)
 */
export function colLetter(colIndex: number): string {
  if (colIndex < 0) throw new Error(`Negative column index: ${colIndex}`);
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/**
 * Builds standard attendance column header: "YYYY-MM-DD | <type> | <email>"
 */
export function buildHeader(date: string, type: 'domain' | 'general', email: string): string {
  return `${date.trim()} | ${type.trim()} | ${email.trim().toLowerCase()}`;
}

/**
 * Parses attendance column header into date, type, email.
 */
export function parseHeader(
  raw: string | null | undefined
): { date: string; type: 'domain' | 'general'; email: string } | null {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [date, type, email] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }

  if (type !== 'domain' && type !== 'general') return null;
  if (!email || !email.includes('@')) return null;

  return { date, type, email: email.toLowerCase() };
}

/**
 * Calculates lastFilled column index (0-based) and nextCol index (at least 4 / column E).
 */
export function findNextColumn(row1: (string | null | undefined)[] | undefined): {
  lastFilledCol: number;
  nextCol: number;
  colLetter: string;
} {
  if (!row1 || !Array.isArray(row1)) {
    return { lastFilledCol: 3, nextCol: 4, colLetter: colLetter(4) };
  }

  let lastFilled = -1;
  for (let i = row1.length - 1; i >= 0; i--) {
    const val = row1[i];
    if (val !== null && val !== undefined && String(val).trim() !== '') {
      lastFilled = i;
      break;
    }
  }

  const nextCol = Math.max(lastFilled + 1, 4);
  return {
    lastFilledCol: lastFilled,
    nextCol,
    colLetter: colLetter(nextCol),
  };
}

/**
 * Validates a tab's structure and contents.
 */
export function validateTab(
  tabTitle: string,
  rows: (string | null | undefined)[][],
  sheetId: number,
  columnCount: number,
  rowCount: number
): TabStructureValidation {
  const problems: SheetProblem[] = [];
  const existing: ExistingMeeting[] = [];
  const roster: SheetRosterMember[] = [];
  const rosterRows: { rowNumber: number; roll: string; name: string }[] = [];

  const row1 = (rows && rows[0]) || [];
  const headerCol0 = String(row1[0] ?? '').trim().toUpperCase();
  const headerCol1 = String(row1[1] ?? '').trim().toUpperCase();

  if (headerCol0 !== 'NAME' || headerCol1 !== 'ROLL NO') {
    problems.push({
      tab: tabTitle,
      row: 1,
      message: `Tab '${tabTitle}' header row 1 columns A-B must be 'NAME' and 'ROLL NO'. Found '${row1[0]}' and '${row1[1]}'.`,
      code: 'SHEET_STRUCTURE',
    });
  }

  // Parse existing attendance columns starting at column E (index 4)
  for (let col = 4; col < row1.length; col++) {
    const headerCell = row1[col];
    if (headerCell && String(headerCell).trim() !== '') {
      const parsed = parseHeader(String(headerCell));
      if (parsed) {
        existing.push({
          date: parsed.date,
          type: parsed.type,
          email: parsed.email,
          rawHeader: String(headerCell),
          colIndex: col,
        });
      }
    }
  }

  // Next column position
  const { lastFilledCol, nextCol } = findNextColumn(row1);

  // Read rows starting at row 2 (index 1)
  const seenRolls = new Set<string>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = String(row[0] ?? '').trim();
    const rawRoll = String(row[1] ?? '').trim();

    // Check if entire row is empty
    const isFullyBlank = row.every((c) => c === null || c === undefined || String(c).trim() === '');
    if (isFullyBlank) {
      continue;
    }

    if (!rawRoll) {
      problems.push({
        tab: tabTitle,
        row: r + 1,
        message: `Row ${r + 1} has a name '${name}' but missing roll number.`,
        code: 'SHEET_STRUCTURE',
      });
      continue;
    }

    if (seenRolls.has(rawRoll)) {
      problems.push({
        tab: tabTitle,
        row: r + 1,
        message: `Duplicate roll number '${rawRoll}' in tab '${tabTitle}' at row ${r + 1}.`,
        code: 'SHEET_STRUCTURE',
      });
    } else {
      seenRolls.add(rawRoll);
    }

    roster.push({ roll: rawRoll, name });
    rosterRows.push({ rowNumber: r + 1, roll: rawRoll, name });
  }

  // Target column empty safety check
  // Verify that in column `nextCol`, every cell from row 1 to rows.length is empty
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    if (nextCol < row.length) {
      const cell = row[nextCol];
      if (cell !== null && cell !== undefined && String(cell).trim() !== '') {
        problems.push({
          tab: tabTitle,
          row: r + 1,
          message: `Target column ${colLetter(nextCol)} is not empty at row ${r + 1} in tab '${tabTitle}'.`,
          code: 'SHEET_STRUCTURE',
        });
        break;
      }
    }
  }

  return {
    valid: problems.length === 0,
    tabTitle,
    sheetId,
    columnCount,
    rowCount,
    roster,
    rosterRows,
    problems,
    lastFilledCol,
    nextCol,
    existing,
  };
}

/**
 * Validates ISO date in Asia/Kolkata timezone against max future/past limits.
 */
export function validateDate(
  dateStr: string,
  isExecutive: boolean,
  now: Date = new Date(),
  options?: { nonExecMaxPastDays?: number; maxFutureDays?: number }
): { valid: boolean; error?: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { valid: false, error: 'Date must be in YYYY-MM-DD format.' };
  }

  const [year, month, day] = dateStr.split('-').map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    return { valid: false, error: `Invalid calendar date '${dateStr}'.` };
  }

  // Get current date in IST (Asia/Kolkata)
  const istFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOM_CONFIG.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayISTStr = istFormatter.format(now); // "YYYY-MM-DD"
  const [tYear, tMonth, tDay] = todayISTStr.split('-').map(Number);
  const todayIST = new Date(Date.UTC(tYear, tMonth - 1, tDay));

  const diffMs = parsedDate.getTime() - todayIST.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  const maxFuture = options?.maxFutureDays ?? MOM_CONFIG.DEFAULT_MAX_FUTURE_DAYS;
  const maxPast = options?.nonExecMaxPastDays ?? MOM_CONFIG.DEFAULT_NONEXEC_MAX_PAST_DAYS;

  if (diffDays > maxFuture) {
    return {
      valid: false,
      error: `Date cannot be more than ${maxFuture} day(s) in the future (today is ${todayISTStr} IST).`,
    };
  }

  if (!isExecutive && diffDays < -maxPast) {
    return {
      valid: false,
      error: `Date cannot be more than ${maxPast} days in the past for non-executives (today is ${todayISTStr} IST).`,
    };
  }

  return { valid: true };
}

/**
 * Plans the attendance write for the requested domains.
 * Pure logic: validates records against rosters, computes duplicate status,
 * constructs cell matrices, and calculates dimension expansions.
 */
export function planAttendanceWrite(params: {
  date: string;
  type: 'domain' | 'general';
  email: string;
  scopeKeys: string[];
  records: AttendanceRecordInput[];
  tabValidations: Record<string, TabStructureValidation>;
  skipConflicts?: boolean;
}): AttendanceWritePlan {
  const {
    date,
    type,
    email,
    scopeKeys,
    records,
    tabValidations,
    skipConflicts = false,
  } = params;

  const problems: SheetProblem[] = [];
  const plannedTabs: AttendanceWritePlanTab[] = [];
  let hasConflict = false;
  let hasStructureProblem = false;

  // 1. Check all tab validations for structure problems
  for (const domainKey of scopeKeys) {
    const val = tabValidations[domainKey];
    if (!val) {
      problems.push({
        tab: domainKey,
        message: `Missing tab structure validation for domain '${domainKey}'.`,
        code: 'SHEET_STRUCTURE',
      });
      hasStructureProblem = true;
      continue;
    }
    if (!val.valid) {
      problems.push(...val.problems);
      hasStructureProblem = true;
    }
  }

  // 2. Validate records
  // Build lookup of input records
  const recordMap = new Map<string, 'P' | 'A'>();
  const inputRollsSeen = new Set<string>();

  for (const rec of records) {
    const roll = String(rec.roll || '').trim();
    if (!roll) {
      problems.push({
        tab: 'input',
        message: 'Record with empty roll number provided.',
        code: 'VALIDATION',
      });
      continue;
    }
    if (inputRollsSeen.has(roll)) {
      problems.push({
        tab: 'input',
        message: `Duplicate roll number '${roll}' in attendance records.`,
        code: 'VALIDATION',
      });
    }
    inputRollsSeen.add(roll);

    if (rec.status !== 'P' && rec.status !== 'A') {
      problems.push({
        tab: 'input',
        message: `Invalid attendance status '${rec.status}' for roll '${roll}'. Must be 'P' or 'A'.`,
        code: 'VALIDATION',
      });
    }
    recordMap.set(roll, rec.status);
  }

  // Target roster rolls across all requested tabs
  const allTargetRolls = new Set<string>();
  const rollsPerDomain = new Map<string, Set<string>>();

  for (const domainKey of scopeKeys) {
    const val = tabValidations[domainKey];
    if (!val) continue;
    const domainRolls = new Set<string>();
    for (const m of val.roster) {
      allTargetRolls.add(m.roll);
      domainRolls.add(m.roll);
    }
    rollsPerDomain.set(domainKey, domainRolls);
  }

  // Check for missing rolls
  for (const expectedRoll of allTargetRolls) {
    if (!recordMap.has(expectedRoll)) {
      problems.push({
        tab: 'input',
        message: `Missing attendance record for roster roll '${expectedRoll}'.`,
        code: 'VALIDATION',
      });
    }
  }

  // Check for unknown rolls
  for (const inputRoll of inputRollsSeen) {
    if (!allTargetRolls.has(inputRoll)) {
      problems.push({
        tab: 'input',
        message: `Unknown roll number '${inputRoll}' in attendance records (not found in target roster).`,
        code: 'VALIDATION',
      });
    }
  }

  // If there are input validation errors or structure errors, we still finish planning
  // but problems are populated.

  // 3. Plan per-tab writes
  const headerString = buildHeader(date, type, email);

  for (const domainKey of scopeKeys) {
    const val = tabValidations[domainKey];
    if (!val) continue;

    // Check duplicate meeting in this tab
    let duplicateStatus: 'ok' | 'already_recorded' | 'conflict' = 'ok';
    const match = val.existing.find((e) => e.date === date && e.type === type);

    if (match) {
      if (match.email && match.email.toLowerCase() === email.toLowerCase()) {
        duplicateStatus = 'already_recorded';
      } else {
        duplicateStatus = 'conflict';
        hasConflict = true;
      }
    }

    if (duplicateStatus === 'conflict' && !skipConflicts) {
      problems.push({
        tab: val.tabTitle,
        message: `Meeting on '${date}' (${type}) was already recorded by '${match?.email || 'another user'}' in tab '${val.tabTitle}'.`,
        code: 'CONFLICT',
      });
    }

    // Build the cell values
    // Cell 0 is the header string.
    // Rows 2..N: match each roster row in val.rosterRows
    const cells: string[] = [headerString];
    const blankRows: number[] = [];
    let presentCount = 0;
    let absentCount = 0;

    for (const rRow of val.rosterRows) {
      const status = recordMap.get(rRow.roll) || 'A';
      if (status === 'P') presentCount++;
      else absentCount++;
      cells.push(status);
    }

    const nextCol = val.nextCol;
    const neededColumns = nextCol >= val.columnCount ? nextCol - val.columnCount + 5 : 0;
    const neededRows = val.rosterRows.length + 1 > val.rowCount ? val.rosterRows.length + 1 - val.rowCount + 5 : 0;

    plannedTabs.push({
      domain: domainKey,
      tabTitle: val.tabTitle,
      sheetId: val.sheetId,
      columnCount: val.columnCount,
      rowCount: val.rowCount,
      nextCol,
      colLetter: colLetter(nextCol),
      header: headerString,
      duplicateStatus,
      cells,
      blankRows,
      presentCount,
      absentCount,
      neededColumns,
      neededRows,
    });
  }

  return {
    tabs: plannedTabs,
    problems,
    hasConflict,
    hasStructureProblem,
  };
}
