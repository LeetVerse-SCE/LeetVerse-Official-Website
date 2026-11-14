import { Request, Response, NextFunction } from 'express';
import { sheets_v4 } from 'googleapis';
import { TAB_NAMES, MOM_CONFIG } from '../config';
import {
  SheetsClient,
  TabMetadata,
} from '../sheetsClient';
import { MembersLoader } from '../membersLoader';
import { DelegationStore } from '../delegationStore';
import { HealthService } from '../healthService';
import { AsyncMutex } from '../mutex';
import {
  validateTab,
  validateDate,
  planAttendanceWrite,
  colLetter,
  isPlaceholderRoll,
} from '../pure';
import { attendancePostSchema, delegationPostSchema } from '../schemas';
import { MomError } from '../middlewares/momErrorHandler';
import { logAuditEvent } from '../auditLogger';
import { AttendanceResult, TabStructureValidation } from '../types';

export class MomController {
  private sheetsClient: SheetsClient;
  private membersLoader: MembersLoader;
  private delegationStore: DelegationStore;
  private healthService: HealthService;
  private mutex: AsyncMutex;
  private sheetId: string;
  private nowFn: () => Date;

  constructor(deps: {
    sheetsClient: SheetsClient;
    membersLoader: MembersLoader;
    delegationStore: DelegationStore;
    healthService: HealthService;
    mutex: AsyncMutex;
    sheetId: string;
    now?: () => Date;
  }) {
    this.sheetsClient = deps.sheetsClient;
    this.membersLoader = deps.membersLoader;
    this.delegationStore = deps.delegationStore;
    this.healthService = deps.healthService;
    this.mutex = deps.mutex;
    this.sheetId = deps.sheetId;
    this.nowFn = deps.now || (() => new Date());
  }

  // GET /mom/health
  public health = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.healthService.checkHealth();
      res.status(result.ok ? 200 : 503).json({
        ok: result.ok,
        missingTabs: result.missingTabs,
      });
    } catch (err) {
      next(err);
    }
  };

  // GET /mom/me
  public getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const access = req.momAccess!;
      const user = req.momUser!;

      // Domains mapped to key and label
      const domains = access.scope.map((key) => ({
        key,
        label: TAB_NAMES[key] || key,
      }));

      // Active delegations manageable by caller
      const manageable = this.delegationStore.listManageable(access);

      res.status(200).json({
        name: access.name || user.name || 'User',
        roll: access.roll || '',
        email: access.email,
        role: access.role,
        domains,
        canGeneral: access.canGeneral,
        canDelegate: access.canDelegate,
        delegations: manageable.map((d) => ({
          domain: d.domain,
          roll: d.roll,
          name: d.name,
          expiresAt: d.expiresAt,
        })),
        delegatedUntil: access.delegatedUntil,
      });
    } catch (err) {
      next(err);
    }
  };

  // GET /mom/roster?scope=<domainKey|ALL>
  public getRoster = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const access = req.momAccess!;
      const requestedScope = String(req.query.scope || '').trim();

      if (!requestedScope) {
        throw new MomError(422, 'VALIDATION', "Query parameter 'scope' is required.");
      }

      if (requestedScope === 'ALL') {
        if (!access.canGeneral) {
          throw new MomError(
            403,
            'FORBIDDEN',
            "Scope 'ALL' requires executive privileges."
          );
        }
      } else {
        if (!access.scope.includes(requestedScope)) {
          throw new MomError(
            403,
            'FORBIDDEN',
            `You do not have access to domain '${requestedScope}'.`
          );
        }
      }

      const domainKeys =
        requestedScope === 'ALL' ? Object.keys(TAB_NAMES) : [requestedScope];
      const tabTitles = domainKeys.map((k) => TAB_NAMES[k]);

      // Read from Sheets (with 15s cache)
      const tabValues = await this.sheetsClient.getTabValuesCached(
        this.sheetId,
        tabTitles
      );
      const metadataMap = await this.sheetsClient.getSpreadsheetMetadata(this.sheetId);

      const domainResults = [];
      const deduplicatedMemberMap = new Map<string, { roll: string; name: string; domains: string[] }>();

      for (const domainKey of domainKeys) {
        const title = TAB_NAMES[domainKey];
        const rows = tabValues[title] || [];
        const meta = metadataMap[title] || { sheetId: 0, columnCount: 26, rowCount: 1000 };

        const val = validateTab(title, rows, meta.sheetId, meta.columnCount, meta.rowCount);

        if (!val.valid) {
          throw new MomError(
            422,
            'SHEET_STRUCTURE',
            `Sheet structure issue in tab '${title}': ${val.problems.map((p) => p.message).join('; ')}`,
            { problems: val.problems }
          );
        }

        domainResults.push({
          key: domainKey,
          label: title,
          members: val.roster,
          existing: val.existing.map((e) => ({
            date: e.date,
            type: e.type,
          })),
        });

        // Deduplication for ALL
        if (requestedScope === 'ALL') {
          for (const m of val.roster) {
            const existing = deduplicatedMemberMap.get(m.roll);
            if (existing) {
              if (!existing.domains.includes(domainKey)) {
                existing.domains.push(domainKey);
              }
            } else {
              deduplicatedMemberMap.set(m.roll, {
                roll: m.roll,
                name: m.name,
                domains: [domainKey],
              });
            }
          }
        }
      }

      const responsePayload: any = {
        scope: requestedScope,
        domains: domainResults,
      };

      if (requestedScope === 'ALL') {
        responsePayload.members = Array.from(deduplicatedMemberMap.values());
      }

      res.status(200).json(responsePayload);
    } catch (err) {
      next(err);
    }
  };

  // POST /mom/attendance
  public postAttendance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parseResult = attendancePostSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new MomError(
          422,
          'VALIDATION',
          parseResult.error.errors.map((e) => e.message).join(', '),
          parseResult.error.format()
        );
      }

      const { date, type, scope, records, skipConflicts, dryRun } = parseResult.data;
      const access = req.momAccess!;
      const user = req.momUser!;
      const isExecutive = access.role === 'executive';

      // 1. Authorize scope & type
      if (type === 'general') {
        if (!access.canGeneral) {
          logAuditEvent({
            ts: this.nowFn().toISOString(),
            requestId: req.requestId || 'unknown',
            actorEmail: user.email,
            role: access.role,
            action: dryRun ? 'attendance_dry_run' : 'attendance_submit',
            scope: [scope],
            date,
            type,
            outcome: 'denied',
            details: { reason: 'General meeting requires executive privileges' },
          });
          throw new MomError(403, 'FORBIDDEN', 'Only executives may submit general meetings.');
        }
        if (scope !== 'ALL') {
          throw new MomError(422, 'VALIDATION', "General meetings must use scope 'ALL'.");
        }
      } else {
        // domain meeting
        if (scope === 'ALL') {
          throw new MomError(422, 'VALIDATION', "Domain meetings cannot use scope 'ALL'.");
        }
        if (!access.scope.includes(scope)) {
          logAuditEvent({
            ts: this.nowFn().toISOString(),
            requestId: req.requestId || 'unknown',
            actorEmail: user.email,
            role: access.role,
            action: dryRun ? 'attendance_dry_run' : 'attendance_submit',
            scope: [scope],
            date,
            type,
            outcome: 'denied',
            details: { reason: `Caller does not have access to scope '${scope}'` },
          });
          throw new MomError(403, 'FORBIDDEN', `You do not have permission to submit attendance for '${scope}'.`);
        }
      }

      // 2. Validate date
      const dateVal = validateDate(date, isExecutive, this.nowFn());
      if (!dateVal.valid) {
        throw new MomError(422, 'VALIDATION', dateVal.error || 'Invalid meeting date.');
      }

      const targetDomainKeys = scope === 'ALL' ? Object.keys(TAB_NAMES) : [scope];
      const targetTabTitles = targetDomainKeys.map((k) => TAB_NAMES[k]);

      // Run inside single-process Mutex
      const result = await this.mutex.runExclusive(async () => {
        // 3. Pre-flight read (fresh read, bypass cache)
        const tabValues = await this.sheetsClient.getTabValues(this.sheetId, targetTabTitles);
        const metadataMap = await this.sheetsClient.getSpreadsheetMetadata(this.sheetId);

        const tabValidations: Record<string, TabStructureValidation> = {};
        for (const domainKey of targetDomainKeys) {
          const title = TAB_NAMES[domainKey];
          const rows = tabValues[title] || [];
          const meta = metadataMap[title] || { sheetId: 0, columnCount: 26, rowCount: 1000 };
          tabValidations[domainKey] = validateTab(
            title,
            rows,
            meta.sheetId,
            meta.columnCount,
            meta.rowCount
          );
        }

        // 4. Plan attendance write
        const plan = planAttendanceWrite({
          date,
          type,
          email: user.email,
          scopeKeys: targetDomainKeys,
          records,
          tabValidations,
          skipConflicts: isExecutive && skipConflicts,
        });

        // Check if there are structure problems or unhandled conflicts
        if (plan.hasStructureProblem) {
          throw new MomError(
            422,
            'SHEET_STRUCTURE',
            'Spreadsheet structure problems detected. No changes were written.',
            { problems: plan.problems }
          );
        }

        if (plan.problems.some((p) => p.code === 'VALIDATION')) {
          throw new MomError(
            422,
            'VALIDATION',
            'Attendance records validation failed.',
            { problems: plan.problems }
          );
        }

        if (plan.hasConflict && (!isExecutive || !skipConflicts)) {
          logAuditEvent({
            ts: this.nowFn().toISOString(),
            requestId: req.requestId || 'unknown',
            actorEmail: user.email,
            role: access.role,
            action: dryRun ? 'attendance_dry_run' : 'attendance_submit',
            scope: targetDomainKeys,
            date,
            type,
            outcome: 'conflict',
          });
          throw new MomError(
            409,
            'CONFLICT',
            'A meeting for this date and type was already recorded by a different user.',
            { problems: plan.problems }
          );
        }

        // Build results
        const results: AttendanceResult[] = plan.tabs.map((tab) => {
          let status: AttendanceResult['status'] = 'written';
          let msg = undefined;

          if (tab.duplicateStatus === 'already_recorded') {
            status = 'already_recorded';
            msg = 'Meeting already recorded by you with identical details.';
          } else if (tab.duplicateStatus === 'conflict') {
            status = 'skipped';
            msg = 'Skipped due to existing conflict.';
          }

          return {
            domain: tab.domain,
            tab: tab.tabTitle,
            status,
            column: tab.colLetter,
            header: tab.header,
            present: tab.presentCount,
            absent: tab.absentCount,
            message: msg,
          };
        });

        // If dry run, return plan immediately without writing
        if (dryRun) {
          logAuditEvent({
            ts: this.nowFn().toISOString(),
            requestId: req.requestId || 'unknown',
            actorEmail: user.email,
            role: access.role,
            action: 'attendance_dry_run',
            scope: targetDomainKeys,
            date,
            type,
            outcome: 'success',
          });
          return {
            ok: true,
            dryRun: true,
            results,
            problems: plan.problems,
          };
        }

        // 5. Construct atomic batchUpdate requests
        const requests: sheets_v4.Schema$Request[] = [];

        for (const tab of plan.tabs) {
          if (tab.duplicateStatus === 'already_recorded' || tab.duplicateStatus === 'conflict') {
            continue; // Nothing to write for this tab
          }

          // Expand columns if nextCol >= columnCount
          if (tab.neededColumns > 0) {
            requests.push({
              appendDimension: {
                sheetId: tab.sheetId,
                dimension: 'COLUMNS',
                length: tab.neededColumns,
              },
            });
          }

          // Expand rows if needed
          if (tab.neededRows > 0) {
            requests.push({
              appendDimension: {
                sheetId: tab.sheetId,
                dimension: 'ROWS',
                length: tab.neededRows,
              },
            });
          }

          // Build row data for updateCells
          // Starting at row 0 (header), column nextCol
          const rowData: sheets_v4.Schema$RowData[] = tab.cells.map((val) => ({
            values: [
              {
                userEnteredValue: {
                  stringValue: val,
                },
              },
            ],
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

        if (requests.length > 0) {
          try {
            await this.sheetsClient.batchUpdate(this.sheetId, requests);
          } catch (writeErr: any) {
            logAuditEvent({
              ts: this.nowFn().toISOString(),
              requestId: req.requestId || 'unknown',
              actorEmail: user.email,
              role: access.role,
              action: 'attendance_submit',
              scope: targetDomainKeys,
              date,
              type,
              outcome: 'failed',
              details: { error: writeErr.message },
            });
            throw new MomError(
              502,
              'UPSTREAM',
              'Attendance write failed or timed out. The spreadsheet may have been updated. Please check before retrying.',
              { originalError: writeErr.message }
            );
          }
        }

        logAuditEvent({
          ts: this.nowFn().toISOString(),
          requestId: req.requestId || 'unknown',
          actorEmail: user.email,
          role: access.role,
          action: 'attendance_submit',
          scope: targetDomainKeys,
          date,
          type,
          outcome: 'success',
        });

        return {
          ok: true,
          results,
          problems: plan.problems,
        };
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  // POST /mom/delegations
  public postDelegation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parseResult = delegationPostSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new MomError(
          422,
          'VALIDATION',
          parseResult.error.errors.map((e) => e.message).join(', ')
        );
      }

      const { roll, domain, hours } = parseResult.data;
      const access = req.momAccess!;
      const user = req.momUser!;

      if (!access.canDelegate) {
        throw new MomError(403, 'FORBIDDEN', 'You do not have permission to grant delegations.');
      }

      const normalizedDomain = domain.trim().toLowerCase();
      const title = TAB_NAMES[normalizedDomain];
      if (!title) {
        throw new MomError(422, 'VALIDATION', `Invalid domain '${normalizedDomain}'.`);
      }

      // Check if target is FIC
      const members = await this.membersLoader.getMembers();
      const targetMember = members.find(
        (m) => m.rollNo && !isPlaceholderRoll(m.rollNo) && m.rollNo.trim() === roll.trim()
      );
      const isFicTarget = targetMember?.domain.trim().toLowerCase() === 'fic';

      // Read sheet tab live to get current roster rolls
      const tabValues = await this.sheetsClient.getTabValues(this.sheetId, [title]);
      const rows = tabValues[title] || [];
      const rosterRolls: string[] = [];
      let targetName: string | undefined = undefined;

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const rName = String(row[0] ?? '').trim();
        const rRoll = String(row[1] ?? '').trim();
        if (rRoll) {
          rosterRolls.push(rRoll);
          if (rRoll === roll.trim()) {
            targetName = rName;
          }
        }
      }

      const grantResult = this.delegationStore.grant({
        domain: normalizedDomain,
        roll,
        name: targetName || targetMember?.name,
        hours,
        grantor: access,
        sheetRosterRolls: rosterRolls,
        isFicTarget,
      });

      if (!grantResult.success) {
        logAuditEvent({
          ts: this.nowFn().toISOString(),
          requestId: req.requestId || 'unknown',
          actorEmail: user.email,
          role: access.role,
          action: 'delegation_grant',
          scope: [normalizedDomain],
          outcome: 'rejected',
          details: { targetRoll: roll, error: grantResult.error },
        });
        throw new MomError(
          grantResult.statusCode as any,
          grantResult.code as any,
          grantResult.error || 'Failed to grant delegation.'
        );
      }

      logAuditEvent({
        ts: this.nowFn().toISOString(),
        requestId: req.requestId || 'unknown',
        actorEmail: user.email,
        role: access.role,
        action: 'delegation_grant',
        scope: [normalizedDomain],
        outcome: 'success',
        details: { targetRoll: roll, expiresAt: grantResult.entry?.expiresAt },
      });

      res.status(200).json({
        ok: true,
        delegation: grantResult.entry,
      });
    } catch (err) {
      next(err);
    }
  };

  // GET /mom/delegations
  public getDelegations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const access = req.momAccess!;
      const manageable = this.delegationStore.listManageable(access);
      res.status(200).json({
        delegations: manageable,
      });
    } catch (err) {
      next(err);
    }
  };

  // DELETE /mom/delegations/:domain/:roll
  public deleteDelegation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const domain = String(req.params.domain);
      const roll = String(req.params.roll);
      const access = req.momAccess!;
      const user = req.momUser!;

      const revokeResult = this.delegationStore.revoke(domain, roll, access);

      if (!revokeResult.success) {
        logAuditEvent({
          ts: this.nowFn().toISOString(),
          requestId: req.requestId || 'unknown',
          actorEmail: user.email,
          role: access.role,
          action: 'delegation_revoke',
          scope: [domain],
          outcome: 'rejected',
          details: { targetRoll: roll, error: revokeResult.error },
        });
        throw new MomError(
          revokeResult.statusCode as any,
          revokeResult.code as any,
          revokeResult.error || 'Failed to revoke delegation.'
        );
      }

      logAuditEvent({
        ts: this.nowFn().toISOString(),
        requestId: req.requestId || 'unknown',
        actorEmail: user.email,
        role: access.role,
        action: 'delegation_revoke',
        scope: [domain],
        outcome: 'success',
        details: { targetRoll: roll },
      });

      res.status(200).json({
        ok: true,
        message: `Delegation for ${domain} (${roll}) revoked successfully.`,
      });
    } catch (err) {
      next(err);
    }
  };
}
