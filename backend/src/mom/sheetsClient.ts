import { google, sheets_v4 } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import { MOM_CONFIG } from './config';

export interface TabMetadata {
  sheetId: number;
  title: string;
  columnCount: number;
  rowCount: number;
}

export interface SheetsClient {
  getSpreadsheetMetadata(spreadsheetId: string): Promise<Record<string, TabMetadata>>;
  getTabValues(
    spreadsheetId: string,
    tabTitles: string[]
  ): Promise<Record<string, (string | null | undefined)[][]>>;
  getTabValuesCached(
    spreadsheetId: string,
    tabTitles: string[]
  ): Promise<Record<string, (string | null | undefined)[][]>>;
  batchUpdate(spreadsheetId: string, requests: sheets_v4.Schema$Request[]): Promise<any>;
}

/**
 * Escapes tab name for Google Sheets A1 range notation:
 * 'SheetName' with single quotes escaped as ''
 */
export function escapeTabNameA1(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

export class GoogleSheetsClient implements SheetsClient {
  private sheetsApi: sheets_v4.Sheets;
  private cachedRoster: {
    timestamp: number;
    data: Record<string, (string | null | undefined)[][]>;
  } | null = null;

  constructor(authClient?: any) {
    if (authClient) {
      this.sheetsApi = google.sheets({ version: 'v4', auth: authClient });
    } else {
      const auth = GoogleSheetsClient.createAuth();
      this.sheetsApi = google.sheets({ version: 'v4', auth });
    }
  }

  private static createAuth(): any {
    // 1. Check for MOM_SHEETS_CREDENTIALS_B64
    const b64 = process.env.MOM_SHEETS_CREDENTIALS_B64;
    if (b64 && b64.trim()) {
      try {
        const decoded = Buffer.from(b64.trim(), 'base64').toString('utf8');
        const creds = JSON.parse(decoded);
        return new google.auth.GoogleAuth({
          credentials: creds,
          scopes: MOM_CONFIG.SHEETS_SCOPES,
        });
      } catch (err) {
        console.warn('[MOM Sheets] Failed to parse MOM_SHEETS_CREDENTIALS_B64, falling back to other credentials.');
      }
    }

    // 2. Check GOOGLE_APPLICATION_CREDENTIALS
    const gCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (gCreds && fs.existsSync(gCreds)) {
      return new google.auth.GoogleAuth({
        keyFile: gCreds,
        scopes: MOM_CONFIG.SHEETS_SCOPES,
      });
    }

    // 3. Check for serviceAccountKey.json or firebase service account key in backend/
    const possibleKeys = [
      path.join(process.cwd(), 'serviceAccountKey.json'),
      path.join(process.cwd(), 'leetverse-website-firebase-adminsdk-fbsvc-291a2e70fe.json'),
      path.join(__dirname, '..', '..', 'leetverse-website-firebase-adminsdk-fbsvc-291a2e70fe.json'),
      path.join(__dirname, '..', '..', 'serviceAccountKey.json'),
    ];

    for (const keyPath of possibleKeys) {
      if (fs.existsSync(keyPath)) {
        return new google.auth.GoogleAuth({
          keyFile: keyPath,
          scopes: MOM_CONFIG.SHEETS_SCOPES,
        });
      }
    }

    // 4. Fallback to default GoogleAuth
    return new google.auth.GoogleAuth({
      scopes: MOM_CONFIG.SHEETS_SCOPES,
    });
  }

  /**
   * Retries an idempotent async operation with exponential backoff for 429/5xx.
   */
  private async retryIdempotent<T>(
    operation: () => Promise<T>,
    maxRetries = 2,
    baseDelayMs = 500
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Google Sheets API request timed out (10s)')), MOM_CONFIG.UPSTREAM_TIMEOUT_MS)
        );
        return await Promise.race([operation(), timeoutPromise]);
      } catch (err: any) {
        attempt++;
        const status = err.status || err.statusCode || (err.response && err.response.status);
        const isRetryable = status === 429 || (status >= 500 && status < 600);

        if (attempt > maxRetries || !isRetryable) {
          throw err;
        }

        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  public async getSpreadsheetMetadata(
    spreadsheetId: string
  ): Promise<Record<string, TabMetadata>> {
    return this.retryIdempotent(async () => {
      const res = await this.sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId,title,gridProperties))',
      });

      const map: Record<string, TabMetadata> = {};
      const sheets = res.data.sheets || [];

      for (const s of sheets) {
        const props = s.properties;
        if (props && props.title) {
          map[props.title] = {
            sheetId: props.sheetId || 0,
            title: props.title,
            columnCount: props.gridProperties?.columnCount || 26,
            rowCount: props.gridProperties?.rowCount || 1000,
          };
        }
      }

      return map;
    });
  }

  public async getTabValues(
    spreadsheetId: string,
    tabTitles: string[]
  ): Promise<Record<string, (string | null | undefined)[][]>> {
    if (tabTitles.length === 0) return {};

    const ranges = tabTitles.map((t) => escapeTabNameA1(t));

    return this.retryIdempotent(async () => {
      const res = await this.sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE',
      });

      const result: Record<string, (string | null | undefined)[][]> = {};
      const valueRanges = res.data.valueRanges || [];

      for (let i = 0; i < tabTitles.length; i++) {
        const title = tabTitles[i];
        const vr = valueRanges[i];
        result[title] = (vr && vr.values) || [];
      }

      return result;
    });
  }

  public async getTabValuesCached(
    spreadsheetId: string,
    tabTitles: string[]
  ): Promise<Record<string, (string | null | undefined)[][]>> {
    const now = Date.now();
    if (
      this.cachedRoster &&
      now - this.cachedRoster.timestamp < MOM_CONFIG.ROSTER_CACHE_TTL_MS
    ) {
      const allPresent = tabTitles.every((t) => this.cachedRoster!.data[t]);
      if (allPresent) {
        return this.cachedRoster.data;
      }
    }

    const fresh = await this.getTabValues(spreadsheetId, tabTitles);
    this.cachedRoster = {
      timestamp: now,
      data: fresh,
    };
    return fresh;
  }

  public async batchUpdate(
    spreadsheetId: string,
    requests: sheets_v4.Schema$Request[]
  ): Promise<any> {
    if (requests.length === 0) return;

    // Single attempt with 10s timeout. Ambiguous failure should NOT be retried blindly.
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Google Sheets batchUpdate timed out (10s)')), MOM_CONFIG.UPSTREAM_TIMEOUT_MS)
    );

    return Promise.race([
      this.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests,
        },
      }),
      timeoutPromise,
    ]);
  }
}

