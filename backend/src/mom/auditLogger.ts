export interface AuditLogEntry {
  ts: string;
  requestId: string;
  actorEmail: string;
  role: string;
  action: 'attendance_submit' | 'attendance_dry_run' | 'delegation_grant' | 'delegation_revoke' | 'access_denied';
  scope: string[];
  date?: string;
  type?: 'domain' | 'general';
  outcome: 'success' | 'conflict' | 'rejected' | 'failed' | 'denied';
  details?: Record<string, any>;
}

export function logAuditEvent(entry: AuditLogEntry): void {
  // Safe structured single line JSON
  const safeEntry = {
    ...entry,
    ts: entry.ts || new Date().toISOString(),
  };
  console.log(`[MOM_AUDIT] ${JSON.stringify(safeEntry)}`);
}

