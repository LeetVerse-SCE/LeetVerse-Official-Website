import { TAB_NAMES, MOM_CONFIG } from './config';
import { DelegationEntry, ResolvedAccess } from './types';

export interface DelegationStoreOptions {
  now?: () => Date;
  maxDelegationHours?: number;
  defaultDelegationHours?: number;
  maxPerGrantor?: number;
}

export class DelegationStore {
  private store = new Map<string, DelegationEntry>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private nowFn: () => Date;
  private maxHours: number;
  private defaultHours: number;
  private maxPerGrantor: number;

  constructor(options?: DelegationStoreOptions) {
    this.nowFn = options?.now || (() => new Date());
    this.maxHours = options?.maxDelegationHours ?? MOM_CONFIG.DEFAULT_MAX_DELEGATION_HOURS;
    this.defaultHours = options?.defaultDelegationHours ?? MOM_CONFIG.DEFAULT_DELEGATION_HOURS;
    this.maxPerGrantor = options?.maxPerGrantor ?? MOM_CONFIG.MAX_DELEGATIONS_PER_GRANTOR;

    this.startSweep();
  }

  public setClock(nowFn: () => Date): void {
    this.nowFn = nowFn;
  }

  public getNow(): Date {
    return this.nowFn();
  }

  private getKey(domain: string, roll: string): string {
    return `${domain.trim().toLowerCase()}:${roll.trim()}`;
  }

  private startSweep(): void {
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, MOM_CONFIG.DELEGATION_SWEEP_INTERVAL_MS);
    if (this.sweepTimer && typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  public stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  public sweep(): void {
    const nowIso = this.nowFn().toISOString();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= nowIso) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Retrieves all active delegations, sweeping expired ones on the fly.
   */
  public getActiveDelegations(
    validateGrantor?: (grantorRoll: string, domain: string) => boolean
  ): DelegationEntry[] {
    const nowIso = this.nowFn().toISOString();
    const active: DelegationEntry[] = [];

    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= nowIso) {
        this.store.delete(key);
        continue;
      }
      if (validateGrantor && !validateGrantor(entry.grantedByRoll, entry.domain)) {
        this.store.delete(key);
        continue;
      }
      active.push({ ...entry });
    }

    return active;
  }

  /**
   * Gets delegations manageable by the caller:
   * - Executives: all active delegations
   * - Leads: active delegations in their domain
   */
  public listManageable(caller: ResolvedAccess): DelegationEntry[] {
    const active = this.getActiveDelegations();
    if (caller.role === 'executive') {
      return active;
    }
    if (caller.role === 'lead') {
      return active.filter((d) => caller.scope.includes(d.domain));
    }
    return [];
  }

  /**
   * Grants a delegation.
   */
  public grant(params: {
    domain: string;
    roll: string;
    name?: string;
    hours?: number;
    grantor: ResolvedAccess;
    sheetRosterRolls: string[];
    isFicTarget?: boolean;
  }): { success: boolean; entry?: DelegationEntry; error?: string; statusCode: number; code: string } {
    const { domain, roll, name, hours, grantor, sheetRosterRolls, isFicTarget } = params;

    const normalizedDomain = domain.trim().toLowerCase();
    const normalizedRoll = roll.trim();

    // 1. Grantor cannot be a delegate
    if (grantor.role === 'delegate' || grantor.role === 'none') {
      return {
        success: false,
        error: 'Only leads and executives can grant delegations.',
        statusCode: 403,
        code: 'FORBIDDEN',
      };
    }

    // 2. Domain must be a valid key in TAB_NAMES and within grantor scope
    if (!Object.prototype.hasOwnProperty.call(TAB_NAMES, normalizedDomain)) {
      return {
        success: false,
        error: `Invalid domain '${normalizedDomain}'.`,
        statusCode: 422,
        code: 'VALIDATION',
      };
    }

    if (!grantor.scope.includes(normalizedDomain)) {
      return {
        success: false,
        error: `Grantor is not authorized to grant delegations for '${normalizedDomain}'.`,
        statusCode: 403,
        code: 'FORBIDDEN',
      };
    }

    // 3. Target cannot be grantor
    if (grantor.roll && grantor.roll.trim() === normalizedRoll) {
      return {
        success: false,
        error: 'Cannot grant delegation to yourself.',
        statusCode: 422,
        code: 'VALIDATION',
      };
    }

    // 4. Target cannot be FIC
    if (isFicTarget) {
      return {
        success: false,
        error: 'Cannot delegate to a Faculty-in-Charge (FIC) member.',
        statusCode: 422,
        code: 'VALIDATION',
      };
    }

    // 5. Target roll must exist in that domain's sheet roster
    if (!sheetRosterRolls.includes(normalizedRoll)) {
      return {
        success: false,
        error: `Target roll '${normalizedRoll}' does not exist in the sheet roster for domain '${normalizedDomain}'.`,
        statusCode: 422,
        code: 'VALIDATION',
      };
    }

    // 6. Hours validation: in (0, MAX_HOURS]
    const grantHours = hours !== undefined ? hours : this.defaultHours;
    if (typeof grantHours !== 'number' || isNaN(grantHours) || grantHours <= 0) {
      return {
        success: false,
        error: 'Delegation duration must be greater than 0 hours.',
        statusCode: 422,
        code: 'VALIDATION',
      };
    }

    if (grantHours > this.maxHours) {
      return {
        success: false,
        error: `Delegation duration cannot exceed ${this.maxHours} hours.`,
        statusCode: 422,
        code: 'VALIDATION',
      };
    }

    // 7. Max 10 active delegations per grantor
    const grantorRoll = grantor.roll || 'unknown';
    const activeFromGrantor = this.getActiveDelegations().filter(
      (d) => d.grantedByRoll === grantorRoll
    );

    const existingKey = this.getKey(normalizedDomain, normalizedRoll);
    const isReplacing = this.store.has(existingKey);

    if (!isReplacing && activeFromGrantor.length >= this.maxPerGrantor) {
      return {
        success: false,
        error: `Grantor already has the maximum of ${this.maxPerGrantor} active delegations.`,
        statusCode: 422,
        code: 'VALIDATION',
      };
    }

    // Compute timestamps
    const now = this.nowFn();
    const expiresAtDate = new Date(now.getTime() + grantHours * 60 * 60 * 1000);

    const entry: DelegationEntry = {
      domain: normalizedDomain,
      roll: normalizedRoll,
      name: name || undefined,
      grantedByRoll: grantorRoll,
      grantedAt: now.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
    };

    this.store.set(existingKey, entry);

    return {
      success: true,
      entry,
      statusCode: 200,
      code: 'OK',
    };
  }

  /**
   * Revokes a delegation.
   */
  public revoke(
    domain: string,
    roll: string,
    caller: ResolvedAccess
  ): { success: boolean; error?: string; statusCode: number; code: string } {
    const key = this.getKey(domain, roll);
    const existing = this.store.get(key);

    if (!existing) {
      return {
        success: false,
        error: `No active delegation found for domain '${domain}' and roll '${roll}'.`,
        statusCode: 404,
        code: 'NOT_FOUND',
      };
    }

    // Authorization: caller is executive, or grantor, or lead of the domain
    const isExecutive = caller.role === 'executive';
    const isGrantor = caller.roll && caller.roll === existing.grantedByRoll;
    const isLeadOfDomain = caller.role === 'lead' && caller.scope.includes(existing.domain);

    if (!isExecutive && !isGrantor && !isLeadOfDomain) {
      return {
        success: false,
        error: 'You are not authorized to revoke this delegation.',
        statusCode: 403,
        code: 'FORBIDDEN',
      };
    }

    this.store.delete(key);
    return {
      success: true,
      statusCode: 200,
      code: 'OK',
    };
  }

  public clear(): void {
    this.store.clear();
  }
}

export const momDelegationStore = new DelegationStore();

