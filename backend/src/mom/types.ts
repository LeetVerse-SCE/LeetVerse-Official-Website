export type MomRole = 'executive' | 'lead' | 'delegate' | 'none';

export interface Member {
  id?: string;
  name: string;
  rollNo: string;
  position: string;
  domain: string;
  domains?: string[];
  status: string;
  email?: string;
}

export interface VerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export interface DelegationEntry {
  domain: string;
  roll: string;
  name?: string;
  grantedByRoll: string;
  grantedAt: string; // ISO
  expiresAt: string; // ISO
}

export interface ResolvedAccess {
  role: MomRole;
  member?: Member;
  roll?: string;
  name?: string;
  email: string;
  scope: string[]; // domain keys e.g. ['web-dev'] or all 9 for executive
  canGeneral: boolean;
  canDelegate: boolean;
  delegatedUntil?: Record<string, string>; // domain -> expiresAt
}

export interface SheetRosterMember {
  roll: string;
  name: string;
}

export interface ExistingMeeting {
  date: string;
  type: 'domain' | 'general';
  email?: string;
  rawHeader?: string;
  colIndex?: number;
}

export interface TabStructureValidation {
  valid: boolean;
  tabTitle: string;
  sheetId: number;
  columnCount: number;
  rowCount: number;
  roster: SheetRosterMember[];
  rosterRows: { rowNumber: number; roll: string; name: string }[];
  problems: SheetProblem[];
  lastFilledCol: number;
  nextCol: number;
  existing: ExistingMeeting[];
}

export interface SheetProblem {
  tab: string;
  row?: number;
  message: string;
  code?: string;
}

export interface AttendanceRecordInput {
  roll: string;
  status: 'P' | 'A';
}

export interface AttendanceWritePlanTab {
  domain: string;
  tabTitle: string;
  sheetId: number;
  columnCount: number;
  rowCount: number;
  nextCol: number;
  colLetter: string;
  header: string;
  duplicateStatus: 'ok' | 'already_recorded' | 'conflict';
  cells: string[]; // header at 0, then one per roster row (index 0..N-1 matching rows 2..end)
  blankRows: number[]; // row indices (0-based from sheet row 2) that are blank and should receive empty {}
  presentCount: number;
  absentCount: number;
  neededColumns: number;
  neededRows: number;
}

export interface AttendanceWritePlan {
  tabs: AttendanceWritePlanTab[];
  problems: SheetProblem[];
  hasConflict: boolean;
  hasStructureProblem: boolean;
}

export interface AttendanceResult {
  domain: string;
  tab: string;
  status: 'written' | 'already_recorded' | 'conflict' | 'skipped';
  column: string;
  header: string;
  present: number;
  absent: number;
  message?: string;
}

export type MomErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'SHEET_STRUCTURE'
  | 'UPSTREAM'
  | 'UNAVAILABLE';

