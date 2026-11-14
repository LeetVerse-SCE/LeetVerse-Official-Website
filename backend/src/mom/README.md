# 🏛️ LeetVerse MOM (Minutes of Meeting) Module

A zero-persistence Express.js micro-architecture designed to bridge **Firebase Authentication**, **Firestore RBAC**, and **Google Sheets API** for automated meeting management, attendance tracking, and temporary role delegation.

---

## ⚡ Architectural Highlights & Technical Highlights

```
┌────────────────────────────────────────────────────────────────────────┐
│                        HTTP / JSON Client (MOM)                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Authorization: Bearer <FirebaseIdToken>
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       Isolated MOM Route Boundary                      │
│   [momRequestId] -> [momCors] -> [momRateLimiter] -> [CircuitBreaker]  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Auth & Role Resolution Engine                      │
│       • admin.auth().verifyIdToken (email_verified === true)           │
│       • Regex Roll Capture: /^(\d{7,8})@kiit\.ac\.in$/                 │
│       • Firestore Read-Only Member Cache (60s TTL)                     │
│       • Dynamic Role Scoping: Executive | Lead | Delegate | FIC        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                     Is Write (POST /mom/attendance)?
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Global In-Process Mutex (AsyncMutex)                  │
│       [Pre-flight Validation] ──▶ [Write Plan] ──▶ [batchUpdate]       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
             ┌──────────────────────┴──────────────────────┐
             ▼                                             ▼
┌──────────────────────────────┐              ┌──────────────────────────────┐
│     In-Memory Delegations    │              │   Atomic Google Sheets v4    │
│  • Map<${domain}:${roll}>    │              │  • batchGet (Multi-tab read) │
│  • 5-min Unref'd Sweep       │              │  • appendDimension (Auto-fit)│
│  • Grantor Re-verification   │              │  • updateCells (P / A status)│
│  • Injectable Virtual Clock  │              │  • Idempotency / Conflict    │
└──────────────────────────────┘              └──────────────────────────────┘
```

---

## 🔑 Core Technical Specifications

### 1. Zero Database Pollution (No Firestore Writes)
* **Design Philosophy**: The application avoids storing meeting contents, transcription bodies, or attendance histories in Firestore.
* **Source of Truth**:
  * **Who can log in & roles**: Evaluated dynamically from read-only Firestore member lists (`members/{domain}/members_listed`).
  * **Who to mark**: Roster read fresh from Google Sheets.
  * **Where attendance is written**: Google Sheets columns via atomic updates.
  * **Delegations**: Volatile in-memory store; server restarts gracefully purge temporary access without orphaned state.

### 2. Single-Process Async Mutex Concurrency Control (`AsyncMutex`)
* **Race Condition Mitigation**: Concurrent submissions targeting the same tab or overlapping dates could result in overwritten columns or duplicated headers.
* **Implementation**: A FIFO promise-chaining async lock (`momAttendanceMutex`) wraps the **entire read-validate-plan-write** sequence. Pre-flight checks and atomic `spreadsheets.batchUpdate` execute strictly sequentially without deadlocks.

### 3. Google Sheets Multi-Tab Atomic Writes
* **Tab Directory**: Configured across 9 domain tabs:
  `Web Development`, `Marketing & PR`, `Video Editing`, `Graphic Designing`, `Competitive Programming`, `Data Science & Data Analytics`, `AI/ML`, `App Development`, and `Cloud`.
* **Grid Auto-Expansion**: Dynamically detects if `nextCol >= columnCount` or `rosterRows.length + 1 > rowCount` and bundles `appendDimension` requests into the payload.
* **Atomicity**: Single-domain and society-wide `general` meetings execute via **one atomic `spreadsheets.batchUpdate` call** spanning up to 9 tabs simultaneously.
* **Idempotency & Conflict Guard**:
  * Duplicate Key: `(date, type)` within a tab.
  * **Identical Submission (`already_recorded`)**: Matches `date`, `type`, and verified `email` in column header ➔ returns `200 OK` with zero duplicate columns created.
  * **Cross-User Conflict (`conflict`)**: Same `date` and `type` by a different user ➔ returns `409 CONFLICT` and aborts all writes.
  * **Executive Override**: Executives can pass `skipConflicts: true` for multi-tab general meetings to write clean tabs while skipping conflicting ones.

### 4. Dynamic Role & Scope Derivation Engine
Evaluated **on every single request** from verified token claims and Firestore data:
* **Executive**: Primary `domain === "executive"`. Granted access to all 9 domains and exclusive authorization to run society-wide `general` meetings.
* **Lead**: Normalized position ends with `lead` (excluding `asst`/`assistant`). Authorized **strictly** for their primary domain. Secondary domains listed in `domains[]` are ignored for scoping to prevent privilege escalation.
* **Faculty-in-Charge (FIC)**: Primary `domain === "fic"`. Explicitly denied all access (`403 FORBIDDEN`), even for delegation targets.
* **Delegates**: Students with active, unexpired in-memory delegations granted by their domain lead or an executive.

### 5. In-Memory Time-Bound Delegation Subsystem
* Keyed as `${domainKey}:${roll}`.
* **Safety Constraints**:
  * Target roll must exist in that domain's Google Sheet roster.
  * Max 10 active delegations per grantor.
  * Duration clamped between 1 hour and 168 hours (7 days).
  * Cannot delegate to oneself or to FIC faculty.
* **Dynamic Grantor Revocation**: On every access check, the grantor's status is re-verified against Firestore. If a lead steps down or is removed, their granted delegations are immediately invalidated.
* **Auto-Eviction**: Automatic background garbage collection sweeps every 5 minutes using `.unref()` so it never prevents clean Node process termination.

### 6. Resilience & Circuit Breaking
* **Health Circuit Breaker (`GET /mom/health`)**:
  * Performs startup and periodic validation of Google Sheet structure.
  * Validates exact tab title names, detecting whitespace errors (e.g. accidental trailing spaces).
  * Automatically puts `/mom/*` into a safe `503 UNAVAILABLE` state if required domain tabs are missing, retrying lazily without crashing the server.
* **Isolated Middleware Boundary**:
  * Dedicated rate limiter (60 req/min per user/IP).
  * Dedicated CORS whitelist (`MOM_ALLOWED_ORIGINS`).
  * Dedicated error boundary mapping internal states to RFC-compliant error structures with `X-Request-Id` tracing.
  * Strict body parser limit (100KB) preventing payload exhaustion attacks.

---

## 📂 File Layout & Responsibilities

```
src/mom/
├── config.ts                    # Tab mappings, IST timezone, delegation constraints
├── types.ts                     # Strict TypeScript interfaces and DTOs
├── pure/
│   └── index.ts                 # 100% deterministic pure business logic (Zero I/O)
├── mutex.ts                     # In-process asynchronous FIFO mutex
├── delegationStore.ts           # Volatile in-memory delegation store with sweep
├── membersLoader.ts             # Firestore members loader with 60s memory caching
├── sheetsClient.ts              # Google Sheets API client with retry and timeouts
├── healthService.ts             # Health check & tab validation circuit breaker
├── auditLogger.ts               # Single-line structured audit logger
├── schemas.ts                   # Zod schemas for request validation
├── middlewares/
│   ├── momAuth.ts               # Token verification & dynamic role resolution
│   ├── momCors.ts               # Isolated CORS handler
│   ├── momRateLimiter.ts        # Isolated 60 req/min rate limiter
│   ├── momRequestId.ts          # Distributed request tracking (X-Request-Id)
│   └── momErrorHandler.ts       # Uniform MOM error responder
├── controllers/
│   └── mom.controller.ts        # HTTP handlers for health, me, roster, attendance, delegations
├── router.ts                    # Dependency-injected router factory (createMomRouter)
└── index.ts                     # Production router wiring and exports
```

---

## 🧪 Comprehensive Verification & Test Suite

The module is verified using Node.js's native test runner (`node:test`) and custom integration tooling under `scripts/mom/`:

```powershell
# 1. Run all 33 unit tests (Pure functions, parsing, date logic, delegation lifecycle)
npm run test:mom

# 2. Run full End-to-End integration test suite (7 comprehensive test suites)
npm run mom:e2e

# 3. Diagnostic tools against live data
npm run mom:check-sheet          # Validates Google Sheet structure and tab headers
npm run mom:check-members        # Validates Firestore members and derives roles
npm run mom:plan                 # Dry-run write planner (Zero writes)
npm run mom:serve-harness        # Standalone mock harness on port 4010
npm run mom:reset-test-sheet     # Safely clears attendance columns on test sheet
```

---

## 🔒 Security Posture

1. **Token Verification**: Every non-public call requires an `Authorization: Bearer <token>` verified via `admin.auth().verifyIdToken` with `email_verified === true`.
2. **Email Masking**: Roll number column (B) is the primary key. Sheet columns C (`Email ID`) and D (`PHONE`) are **never read, returned, or logged** by the backend.
3. **Audit Trail**: Every attendance write, dry run, delegation grant, and denial logs a single structured JSON line containing timestamps, user IDs, request IDs, actions, and scopes. No tokens or credentials are ever logged.
4. **Credential Isolation**: Service account JSON keys are untracked by Git, with automatic fallback resolution between `GOOGLE_APPLICATION_CREDENTIALS`, `MOM_SHEETS_CREDENTIALS_B64`, and local service account keys.

