import { TAB_NAMES } from './config';
import { SheetsClient, TabMetadata } from './sheetsClient';

export interface HealthCheckResult {
  ok: boolean;
  missingTabs: string[];
  tabMetadata?: Record<string, TabMetadata>;
}

export class HealthService {
  private sheetsClient: SheetsClient;
  private sheetId: string;
  private lastCheckResult: HealthCheckResult | null = null;
  private lastCheckTime = 0;
  private checkIntervalMs = 60 * 1000; // 1 min lazy re-check if unhealthy
  private inFlightCheck: Promise<HealthCheckResult> | null = null;

  constructor(sheetsClient: SheetsClient, sheetId: string) {
    this.sheetsClient = sheetsClient;
    this.sheetId = sheetId;
  }

  public setSheetId(sheetId: string): void {
    this.sheetId = sheetId;
    this.lastCheckResult = null;
    this.lastCheckTime = 0;
  }

  public async checkHealth(forceFresh = false): Promise<HealthCheckResult> {
    const now = Date.now();
    if (
      !forceFresh &&
      this.lastCheckResult &&
      this.lastCheckResult.ok &&
      now - this.lastCheckTime < this.checkIntervalMs
    ) {
      return this.lastCheckResult;
    }

    if (this.inFlightCheck) {
      return this.inFlightCheck;
    }

    this.inFlightCheck = this.performCheck().finally(() => {
      this.inFlightCheck = null;
    });

    return this.inFlightCheck;
  }

  private async performCheck(): Promise<HealthCheckResult> {
    try {
      if (!this.sheetId) {
        const result: HealthCheckResult = {
          ok: false,
          missingTabs: Object.values(TAB_NAMES),
        };
        this.lastCheckResult = result;
        this.lastCheckTime = Date.now();
        return result;
      }

      const metadataMap = await this.sheetsClient.getSpreadsheetMetadata(this.sheetId);
      const existingTabTitles = new Set(Object.keys(metadataMap));

      const missingTabs: string[] = [];
      for (const requiredTitle of Object.values(TAB_NAMES)) {
        if (!existingTabTitles.has(requiredTitle)) {
          missingTabs.push(requiredTitle);
        }
      }

      const ok = missingTabs.length === 0;
      const result: HealthCheckResult = {
        ok,
        missingTabs,
        tabMetadata: ok ? metadataMap : undefined,
      };

      this.lastCheckResult = result;
      this.lastCheckTime = Date.now();

      if (!ok) {
        console.warn(`[MOM Health] Module unhealthy. Missing tabs: ${missingTabs.join(', ')}`);
      }

      return result;
    } catch (err: any) {
      console.error('[MOM Health] Failed to perform health check against Google Sheets:', err.message);
      const result: HealthCheckResult = {
        ok: false,
        missingTabs: Object.values(TAB_NAMES),
      };
      this.lastCheckResult = result;
      this.lastCheckTime = Date.now();
      return result;
    }
  }

  public getCachedMetadata(): Record<string, TabMetadata> | undefined {
    return this.lastCheckResult?.tabMetadata;
  }

  public isHealthy(): boolean {
    return this.lastCheckResult?.ok === true;
  }
}

