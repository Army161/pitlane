# PITLANE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the complete web-first PITLANE evidence service, with real durable storage/queue and hosted integration paths, without activating payments or publishing before owner setup.

**Architecture:** A TypeScript modular monolith exposes a Next.js web/API and separate inspection worker sharing deterministic contracts. Postgres owns authorization, leases, quotas and accounting; Supabase Auth/private Storage and an independent read-only RPC gateway and configured upstream providers are real adapters. A billing dispatcher has separate capabilities and captures eligible one-off funds only after accessible billable delivery.

**Tech Stack:** Node supported LTS, pnpm, TypeScript, Next.js, Zod, parameterized Postgres SQL, official Solana program codecs, Supabase SDK, Stripe SDK, Vitest and Playwright. Pin verified compatible stable versions at execution; no fabricated version numbers.

**Spec:** `docs/superpowers/specs/2026-10-05-pitlane-design.md` version 0.2. Read both documents; the spec is authoritative. The inaccessible pasted attachment is not a source.

## Global Constraints

- Web first, Android/iOS later, through the same `/v1` API.
- Real durable jobs, private tenant data, deterministic assertions, immutable retained evidence, and truthful origin labels.
- Four supported Token-2022 extensions: TransferFeeConfig, MintCloseAuthority, MetadataPointer, TokenMetadata; all other extensions remain unsupported.
- Metadata limits: payload 16,384 bytes; name 128; symbol 32; URI 2,048; 32 additional pairs; key 64; value 1,024; strict UTF-8 and prefix validation before allocation.
- Deadline 180 seconds from queue admission; lease 60 seconds; heartbeat 15 seconds; three execution attempts; 16 RPC requests; call timeout eight seconds; response cap 256 KiB; two active jobs per project.
- Two independent configured upstreams; finalized observations; paired acquisition ≤30 seconds and initial slot skew ≤150. Compare required configuration projections, retaining mutable observations separately.
- Quote expiry/admission funding hold 10 minutes. Exact integer amounts. Reserve subscription units; capture eligible one-offs only after billable receipt delivery. No upfront or automatic-delayed capture.
- No signing, chain writes, URI fetches, customer scripts, wallet/custody/payout/token issuance, fabricated users/revenue, unrelated project changes or external agents.
- Owner approval still gates purchases/recurring costs, provisioning with cost implications, credentials, production SMTP, public publication and live payments. Local/test adapters never masquerade as live integrations.

## Review Focus

1. A metadata length prefix claims a huge allocation despite a small buffer: reject before allocation, not after memory exhaustion (Task 3).
2. A provider reports a different mint supply but identical required configuration: retain both values and corroborate only the required projection (Task 4).
3. A queued worker loses its lease immediately before finalization: stale completion must fail without quota/capture effects (Task 7).
4. Authorization expires after receipt delivery but before capture confirmation: preserve receipt, reconcile collection, never silently authorize again (Task 12).
5. A user loses project access during an event stream or download: close/reject further output and prevent tenant cache reuse (Tasks 9–10).

---

## Execution and repository decisions

This is one integrated plan because shared schemas and database transactions couple the subsystems. Tasks yield independently tested deliverables and commit gates; grouping them into unrelated parallel plans would obscure interface dependencies. Jeremy has now explicitly approved end-to-end execution, superseding the previous stop-after-plan instruction. Proceed after document self-review; maintain a task ledger and obtain a fresh independent whole-system review. Never claim a hosted gate passed without configured resources and an observed result.

Create the new repository only inside the dedicated `PITLANE` folder, on `feat/pitlane-build`; do not modify another checkout or global Git settings. The dedicated new project is the isolated workspace. Preserve existing docs. If a managed worktree is later useful, keep it inside the assigned writable workspace. Use a plan ledger at `.superpowers/sdd/2026-10-05-pitlane-implementation/progress.md`, record task BASE/commit, red/green commands, rulings and blockers before context compaction.

Test cycle for every task: write the named failing test and its assertions, run the task command and observe failure, implement only the specified interface, run the same command and observe success, then commit its files. Infrastructure failure is not a successful red test. Final suite, typecheck/build and browser acceptance must be green after integration.

## File map and shared interfaces

All paths below are relative to `PITLANE`. Each feature module owns its ports, service and tests; avoid a single catch-all application file.

| Path | Responsibility |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts` | Reproducible workspace scripts and strict compilation. |
| `packages/contracts/src/{domain,schemas,limits}.ts` | Domain types, JSON validation, constants, OpenAPI schemas and immutable rule versions. |
| `packages/evidence/src/{mint,metadata,projections,expectations,receipt}.ts` | Pure address/account decoding, bounded metadata, corroboration, predicates, canonical hashes and rendering. |
| `packages/core/src/{ports,access,quotes,jobs,artifacts,atlas,monitors,billing,costs}.ts` | Business operations independent of HTTP/React. |
| `packages/adapters/src/{postgres,supabase-auth,supabase-storage,solana-rpc,stripe}.ts` | Real external adapters with capability limits; fixture adapters live under test/local-only entrypoints. |
| `db/migrations/001_access.sql` through `006_operations.sql` | Tenant/RLS, durable work, immutable evidence, quota/cost, payment journal and monitoring/Atlas lifecycle. |
| `apps/web/src/app/{layout,page}.tsx`, `apps/web/src/app/v1/**/route.ts` | Six-area UI, session boundary and API handlers using core services. |
| `apps/gateway/src/{server,main}.ts`; `apps/worker/src/{main,runner,scheduler}.ts` | Independent gateway dispatch; worker lease loop, bounded inspection, reaper and monitor scheduling. Provider secrets remain in the gateway. |
| `apps/billing/src/main.ts` | Isolated outbox dispatcher, initially disabled/fake or sandbox only under approved setup. |
| `tests/{unit,integration,e2e,fixtures}/` | Pure fixtures, real Postgres race/RLS, browser journeys and fault injection. |
| `config/{runtime.schema,railway-web,railway-worker,railway-billing}.json` | Environment identity and deployment contract; no credentials committed. |
| `docs/{manual,setup,verification,launch-readiness}.md` | Supported behavior, runnable setup, observed results and activation blockers. |

Task 1 defines these exported contract types once: `Actor {userId,tenantId}`, `Scope {tenantId,projectId}`, `JobInput`, `Quote`, `Job`, `Lease {jobId,workerId,epoch,expiresAt}`, `Observation`, `DecodedMint`, `Projection`, `Assertion`, `Receipt`, `ArtifactManifest`, `Order`, `PaymentState`, `Money {asset,scale,baseUnits}`, `Result<T>`, `Clock {now():Date}`, `Db {transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>}`, `Tx`, `RpcPort`, `StoragePort`, `AuthPort`, `BillingPort`, `RuntimeConfig`. String IDs and decimal integer strings remain opaque; use discriminated errors, no hidden defaults.

All later exact service signatures below consume those types. Asynchronous operations return promises; pure evidence functions do not. Money and evidence errors must use stable reason codes. No caller supplies a trusted tenant membership, settled-payment fact or finding status.

## Task 1: Contracts and runnable test/build workspace

**Files:** Create workspace files above; `packages/contracts/src/domain.ts`, `schemas.ts`, `limits.ts`; `tests/unit/contracts.test.ts`; `config/runtime.schema.json`.

**Interfaces:** Produce `parseJobInput(value:unknown):Result<JobInput>`, `parseRuntimeConfig(value:unknown):Result<RuntimeConfig>`, shared types and exact limits. Export all through `packages/contracts/src/index.ts`.

- [ ] Write `rejects_invalid_scope_and_oversized_predicates`: `expect(parseJobInput({...validInput, expectations:Array(33).fill(validPredicate)}).ok).toBe(false)`; reject missing explicit network, foreign field injection and unsafe integer encoding.
- [ ] Run `pnpm exec vitest run tests/unit/contracts.test.ts`; expected assertion/import failure before implementation. Bootstrap only the runner/dependencies needed to observe it.
- [ ] Implement the schemas/types and environment mode checks; fixture/fake mode must fail production startup. Add scripts `test`, `typecheck`, `build`, `test:integration`, `test:e2e`, `dev:web`, `dev:worker`.
- [ ] Rerun task command and `pnpm typecheck`; expect all cases pass and exit 0.
- [ ] Commit workspace/contracts/config without secrets: `feat: define PITLANE contracts and limits`.

## Task 2: Full-address and mint decoding

**Files:** `packages/evidence/src/mint.ts`; `tests/unit/mint.test.ts`; `tests/fixtures/mints/*` with fixture provenance README.

**Interfaces:** Consume `JobInput`, `DecodedMint`; produce `validateMintAddress(text:string):Result<string>` and `decodeMint(bytes:Uint8Array, owner:string, subject:string):Result<DecodedMint>`.

- [ ] Write `accepts_off_curve_address_but_rejects_non_mint`: assert a valid 32-byte off-curve address validates; wrong owner, executable/uninitialized account, truncated TLV and duplicate extensions fail with distinct reasons.
- [ ] Run `pnpm exec vitest run tests/unit/mint.test.ts`; observe genuine failure.
- [ ] Implement with pinned official read-only codecs and exact integers; validate the original program and four-extension whitelist before claiming complete coverage.
- [ ] Rerun same command; include u64 boundary, both fee schedules, authority null/address and supported extension combinations; expect pass.
- [ ] Commit `feat: decode supported Solana mint configuration`.

## Task 3: Bounded embedded TokenMetadata

**Files:** `packages/evidence/src/metadata.ts`; `tests/unit/metadata.test.ts`; bounded metadata fixtures.

**Interfaces:** Consume `DecodedMint`; produce `decodeTokenMetadata(bytes:Uint8Array, subject:string):Result<DecodedMint['metadata']>`; Task 2's decoder delegates to it.

- [ ] Write `rejects_huge_prefix_before_allocation`, `enforces_utf8_byte_limits` and `keeps_uri_inert`: 16,384-byte payload passes if otherwise valid; 16,385 is unsupported; name 128/129 and multibyte UTF-8 are measured in bytes; malformed UTF-8, duplicate keys and embedded-mint mismatch fail; a `javascript:` URI remains an escaped string and makes zero network calls.
- [ ] Run `pnpm exec vitest run tests/unit/metadata.test.ts`; observe failure.
- [ ] Implement bounded prefix scanning before official decode, strict UTF-8, 32-pair/key/value/URI limits and canonical key ordering without normalizing text. Preserve raw vector order separately.
- [ ] Rerun same command plus mint tests; expect pass, including external metadata pointer limitations and unknown extensions still unsupported.
- [ ] Commit `feat: add bounded read-only token metadata`.

## Task 4: Projection corroboration and deterministic expectations

**Files:** `packages/evidence/src/projections.ts`, `expectations.ts`; `tests/unit/projections.test.ts`, `expectations.test.ts`.

**Interfaces:** Produce `projectRequired(mint:DecodedMint,input:JobInput):Projection`, `corroborate(observations:Observation[],input:JobInput):Result<Projection>` and `evaluateExpectations(projection:Projection,input:JobInput):Assertion[]`.

- [ ] Write `supply_change_does_not_invent_conflict`: equal required configuration with supply `100`/`101` yields supported projection and informational `varied`; mint-authority mismatch yields insufficient. Missing required source/predicate cannot pass. Both stored fee schedules must meet caps; empty predicates and contradictory sets are rejected.
- [ ] Run `pnpm exec vitest run tests/unit/projections.test.ts tests/unit/expectations.test.ts`; observe failure.
- [ ] Implement template-specific required field paths, structural checks and aggregate precedence. Preserve all per-provider mutable values and disclose unrequested differences; metadata comparison uses exact stored values.
- [ ] Rerun command; cover ≤30-second pair, ≤150-slot skew, genesis/upstream independence and disagreement in a required metadata field; expect pass.
- [ ] Commit `feat: verify scoped configuration expectations`.

## Task 5: Real database schema, scoped access and migration runner

**Files:** `db/migrations/001_access.sql`, `002_jobs.sql`, `003_evidence.sql`, `004_accounting.sql`, `005_payments.sql`, `006_operations.sql`; `packages/adapters/src/postgres.ts`; `packages/core/src/access.ts`; `tests/integration/access.test.ts`, `migrations.test.ts`.

**Interfaces:** Produce `PostgresDb implements Db`, `authorize(actor:Actor,scope:Scope,action:string,tx:Tx):Promise<void>` and reviewed migration execution. Narrow worker procedures validate scope/lease; web role has no BYPASSRLS.

- [ ] Write `foreign_tenant_reference_is_rejected`: two tenants/project roles cannot select, insert or join foreign evidence; billing-only role cannot read project records; runtime roles cannot alter receipts or money directly.
- [ ] Run `pnpm test:integration -- access migrations` against an explicitly configured isolated database; expect failing constraints/policies, not a connection error counted as red.
- [ ] Implement composite keys/RLS, schemas/indexes, balanced journal constraint, fixed-search-path capability procedures and migration lock. No production credentials or unrelated DBs are used.
- [ ] Rerun command; empty/prior migration states and 20 concurrent isolation probes pass. If no DB is authorized/available, keep this task explicitly blocked and continue pure/local tasks; do not replace this proof with mocks.
- [ ] Commit `feat: establish durable tenant and accounting schema`.

## Task 6: Quotes, idempotent admission and cost reservations

**Files:** `packages/core/src/quotes.ts`, `costs.ts`, `ports.ts`; `tests/integration/admission.test.ts`; safe local persistence adapter only for explicit local development.

**Interfaces:** `quote(actor:Actor,input:JobInput):Promise<Quote>`; `submit(actor:Actor,quoteId:string,key:string):Promise<Job>`; `reserveCost(tx:Tx,scope:Scope,jobId:string,maximum:Money):Promise<void>`.

- [ ] Write `last_unit_has_one_winner`: 20 distinct requests compete for one allowance and exactly one reservation exists; 20 duplicate requests return one job; changed payload/same key gets 409; expired quote rolls back all effects.
- [ ] Run `pnpm test:integration -- admission`; observe failed invariants.
- [ ] Implement fixed lock order, one-minute canonical request dedupe, subscription versus authorized one-off admission, scope checks and transactional budget caps. Record origin from trusted server mode/funding, not client declarations.
- [ ] Rerun command; unsupported input never reserves funds/units and provider/global budget races cannot over-allocate.
- [ ] Commit `feat: admit quoted jobs exactly once per business identity`.

## Task 7: Durable leases, retries and cancellation

**Files:** `packages/core/src/jobs.ts`; `apps/worker/src/runner.ts`; `tests/integration/jobs.test.ts`.

**Interfaces:** `claim(workerId:string):Promise<Lease|null>`, `heartbeat(lease:Lease):Promise<boolean>`, `requestCancel(actor:Actor,jobId:string):Promise<Job>`, `reap(now:Date):Promise<number>` and `finalize(lease:Lease,result:Receipt,manifest:ArtifactManifest):Promise<Job>`.

- [ ] Write `stale_epoch_cannot_finalize`: expire/reclaim a lease, then old epoch finalization creates no receipt, unit consumption or capture event. Killing after claim survives restart; accepted cancellation wins before delivery; after delivery it returns current completion.
- [ ] Run `pnpm test:integration -- jobs`; observe failure.
- [ ] Implement SKIP LOCKED claim, 60/15-second lease/heartbeat, three-attempt/180-second limits, retry_wait/reaper, conditional transitions and safe event sequences. External calls hold no DB locks.
- [ ] Rerun command with kill points before/after dispatch/finalization and deadline limits; expect durable recovery and one completion.
- [ ] Commit `feat: recover durable inspection jobs with fenced leases`.

## Task 8: Independent read-only RPC gateway, metering and inspection runner

**Files:** `packages/adapters/src/solana-rpc.ts` (SolanaRpc in gateway, GatewayRpc in worker); `apps/gateway/src/server.ts`, `main.ts`; `apps/worker/src/main.ts`; `tests/unit/rpc.test.ts`, `gateway.test.ts`, `tests/integration/inspection.test.ts`.

**Interfaces:** `SolanaRpc implements RpcPort`; `collect(input:JobInput,lease:Lease):Promise<Observation[]>`; `inspect(lease:Lease):Promise<void>` uses Tasks 2–4/7 and explicit cost intents.

- [ ] Write `broadcast_rejected_before_http`: prohibited method/payload and unconfigured URL make zero requests; timeout/429 honors remaining budget; provider/auth/genesis errors never become a pass.
- [ ] Run `pnpm exec vitest run tests/unit/rpc.test.ts`; observe failure.
- [ ] Implement a separate authenticated gateway with only four allowed reads, strict parameters, no caller endpoints/headers, TLS/response caps, redirect rejection, finalized anchors, durable dispatch-intent checks, shared provider rate limits and exact per-attempt metering. Workers receive only GatewayRpc plus gateway service credentials, never upstream credentials. Decode/corroborate/evaluate before finalization. Local fixture adapter is impossible in production.
- [ ] Run unit command and `pnpm test:integration -- inspection`; verify staged restart, uncertain dispatch cost, two-source policy and receipt outcome under injected outages.
- [ ] Commit `feat: run bounded read-only evidence inspections`.

## Task 9: Artifact publication, receipts and correction history

**Files:** `packages/evidence/src/receipt.ts`; `packages/core/src/artifacts.ts`; `packages/adapters/src/supabase-storage.ts`; `tests/unit/receipt.test.ts`, `tests/integration/artifacts.test.ts`.

**Interfaces:** `buildReceipt(input:JobInput,observations:Observation[],assertions:Assertion[]):Receipt`, `publish(lease:Lease,receipt:Receipt):Promise<ArtifactManifest>`, `supersede(actor:Actor,versionId:string,correction:Receipt):Promise<Receipt>` and authorized streamed `download(actor:Actor,artifactId:string):Promise<ReadableStream>`.

- [ ] Write `missing_object_cannot_complete` and `revoked_download_stops`: failed upload/digest mismatch/pending object prevents delivery/capture; previous receipt survives correction; removed membership rejects subsequent download output.
- [ ] Run `pnpm exec vitest run tests/unit/receipt.test.ts` and `pnpm test:integration -- artifacts`; observe failure.
- [ ] Implement canonical JSON/SHA-256, noncircular payload/manifest, deterministic readable rendering, private job-bound uploads, publish state machine, same-project correction CAS and 24-hour orphan cleanup.
- [ ] Rerun; immutable versions cannot update/delete under runtime roles, per-source varied values survive replay, correction adds no customer debit, and no URL carries credentials.
- [ ] Commit `feat: publish reproducible private receipt history`.

## Task 10: Supabase sessions and authenticated API/events

**Files:** `packages/adapters/src/supabase-auth.ts`; `apps/web/src/lib/session.ts`, `api.ts`; `apps/web/src/app/auth/**/route.ts`, `v1/**/route.ts`; `tests/integration/api.test.ts`, `sessions.test.ts`.

**Interfaces:** `SupabaseAuth implements AuthPort`; `authenticate(request:Request):Promise<Actor>`; route handlers call the core interfaces above and return exact spec JSON/errors; `streamEvents(actor:Actor,jobId:string,cursor:number):ReadableStream`.

- [ ] Write `revoked_stream_closes` and `foreign_quote_is_404`: current membership revocation closes within 30 seconds; cursor resumes no duplicate sequence; user input cannot choose trusted origin; cookie write without CSRF fails; billing role cannot read evidence.
- [ ] Run `pnpm test:integration -- api sessions`; observe failure.
- [ ] Implement server-owned refresh/login/logout, issuer/audience/expiry verification, exact callbacks, no-store headers, scoped errors/rate/body limits, SSE and polling fallback. Do not configure SMTP/OAuth externally without owner setup.
- [ ] Rerun; list/search/receipt/change/cancel/artifact endpoints and tenant switches pass adversarial cases.
- [ ] Commit `feat: expose scoped evidence API and sessions`.

## Task 11: Ledger, payment inbox and subscription allowances

**Files:** `packages/core/src/billing.ts`; `packages/adapters/src/stripe.ts`; `apps/web/src/app/v1/webhooks/stripe/route.ts`; `tests/integration/billing.test.ts`.

**Interfaces:** `StripeBilling implements BillingPort`; `ingestWebhook(raw:Uint8Array,signature:string):Promise<void>`, `reconcilePayment(orderId:string):Promise<PaymentState>` and `applySubscriptionEvent(eventId:string):Promise<void>`.

- [ ] Write `duplicate_invoice_grants_once`: duplicate/out-of-order sandbox events create one correct-period entitlement; invalid signature/foreign environment does nothing; journal is balanced and test funds excluded from live demand.
- [ ] Run `pnpm test:integration -- billing`; observe failure.
- [ ] Implement raw-body verification, durable inbox/ordered state transitions, provider retrieval, unique journal sources, refund caps/reversals, disputes and separate amount scales. Fake adapter is tests/local only; Stripe live mode is disabled.
- [ ] Rerun; ambiguous responses remain pending and changing price/plan never resets consumed usage through duplicate events.
- [ ] Commit `feat: account for subscriptions and verified payment events`.

## Task 12: Delivery-before-capture, expiry and pilot order

**Files:** `packages/core/src/orders.ts`; `apps/billing/src/main.ts`; `tests/integration/capture.test.ts`, `pilot.test.ts`.

**Interfaces:** `authorizeOrder(actor:Actor,quoteId:string,key:string):Promise<Order>`, `recordDelivery(tx:Tx,orderId:string,versionId:string):Promise<void>`, `dispatchBilling(limit:number):Promise<number>` and `recordPilotSummary(actor:Actor,orderId:string,artifactId:string,minutes:number):Promise<Order>`.

- [ ] Write `capture_follows_accessible_delivery`: authorization may admit work but capture count stays zero before published receipt; contradiction is billable; insufficient/unsupported/cancel-before-delivery cancels authorization only. `expiry_after_delivery_preserves_receipt` yields pending reconciliation/failed collection, zero settled revenue and no fresh authorization. Duplicate pilot completion captures $199 once and grants ≤5 retest units once for 30 days.
- [ ] Run `pnpm test:integration -- capture pilot`; observe failure.
- [ ] Implement manual-capture-card eligibility, provider expiry/amount checks, 10-minute funding hold, delivery commit then unique order/capture outbox, cancellation/collection locks and ambiguous-timeout retrieval. Human minutes cap at 45; pilot capture requires initial agreed receipts plus actual accessible summary. No per-unit pilot captures or invented summary completion.
- [ ] Rerun; race cancellation/capture/expiry and replay beyond provider key lifetime; verify no automatic fallback method, no automatic-delayed capture and refunds bounded by settled funds.
- [ ] Commit `feat: capture eligible payments only after billable delivery`.

## Task 13: Permissioned Atlas, monitoring and retention

**Files:** `packages/core/src/atlas.ts`, `monitors.ts`, `retention.ts`; `apps/worker/src/scheduler.ts`; `tests/integration/lifecycle.test.ts`.

**Interfaces:** `confirmCase(actor:Actor,caseId:string,regressionArtifactId:string):Promise<void>`, `setMonitor(actor:Actor,id:string,enabled:boolean):Promise<void>`, `scheduleDue(now:Date):Promise<number>` and `purgeExpired(now:Date):Promise<number>`.

- [ ] Write `disabled_monitor_has_no_work`: duplicate due claims create one normal reserved job; restart backfills ≤1 window; policy/price/quota/consent changes pause. Private case cannot cross tenant; withdrawing permission prevents new reuse. Expired/deleted artifacts become inaccessible without editable history.
- [ ] Run `pnpm test:integration -- lifecycle`; observe failure.
- [ ] Implement confirmed fix/regression evidence, immutable case corrections, explicit permissions, hourly minimum/default daily monitors, reserved cost caps, 90-day evidence and permissioned 365-day Atlas retention, immediate access revocation and ≤30-day eligible primary purge.
- [ ] Rerun; audit/tombstones contain no private payload, object/DB purge order is restart-safe and notifications stay scoped/in-app.
- [ ] Commit `feat: retain permissioned cases and bounded customer monitoring`.

## Task 14: Complete six-area web application

**Files:** `apps/web/src/app/layout.tsx`, `page.tsx`, `garage/page.tsx`, `crew/page.tsx`, `records/page.tsx`, `treasury/page.tsx`, `book/page.tsx`, `manual/page.tsx`; focused components and styles; `tests/e2e/journey.spec.ts`, `accessibility.spec.ts`.

**Interfaces:** Consume `/v1` contracts only; no direct client accounting/storage writes. Render real state and evidence fields, project switcher, permission-sensitive controls, Atlas/monitor/history/export within Records, administration/pilot summary within authorized operations.

- [ ] Write `book_to_receipt_and_negative_outcome`: authenticated permitted project submits/quotes, follows actual event stream, views and exports exact receipt; negative/insufficient outcomes and cancellation are honest. All six routes have meaningful empty/real-data states, not fabricated metrics. URI/HTML/bidi fixtures remain inert/visible.
- [ ] Run `pnpm exec playwright test tests/e2e/journey.spec.ts`; observe expected missing/incorrect behavior.
- [ ] Implement original responsive garage visual design, keyboard focus/reduced motion, real query/event hooks, actionable error states, unit/capture explanations and scopes. AI explanations may remain disabled; deterministic rendering must work.
- [ ] Run `pnpm test:e2e`; check mobile viewport, accessibility, tenant switching/logout, revoked stream and browser console; expect pass.
- [ ] Commit `feat: deliver the complete PITLANE web workflow`.

## Task 15: Operations, launch evidence and independent review

**Files:** deployment/config files; `docs/manual.md`, `setup.md`, `verification.md`, `launch-readiness.md`; `tests/integration/restore.test.ts`, `config.test.ts`; release source archive with manifests.

**Interfaces:** `loadConfig(env:Record<string,string|undefined>):RuntimeConfig`, `health():Promise<{ready:boolean,reason?:string}>`; documented build/start/drain commands. No configuration sample contains live secrets or guessed project/provider URLs.

- [ ] Write `production_refuses_fixture_or_foreign_project`: wrong identity/mode fails startup; SIGTERM stops claims and preserves unfinished leases; restores verify DB references plus object hashes, not DB alone.
- [ ] Run `pnpm test:integration -- config restore`; observe failure when the approved isolated environment is available; otherwise record exact blocked gates.
- [ ] Implement Railpack service configs, bounded pools/restart alert requirements, worker autosleep OFF contract, migration/rolling compatibility, safe cost alerts, independently deployed gateway and real adapter setup docs. The chosen worker host must enforce deny-by-default egress to the scoped database, artifact API and gateway; a source allowlist is insufficient. Do not provision/publish/activate money without required owner decisions.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:integration`, `pnpm test:e2e`; record exact results/screenshots and unrun gates. Dispatch a fresh independent review of code/spec/ledger; fix important findings through reproducible failing tests and a green whole suite.
- [ ] Commit tested changes and publish source/docs to private Library through supported workflow. Mark launch-ready only when hosted two-provider receipt, private access, migrations/restoration, cost measurement and applicable billing gates actually pass; otherwise call the result locally verified with explicit activation blockers.

## Coverage map and self-review

| Spec sections | Tasks / release proof |
|---|---|
| 1–3 scope, modules and six surfaces | 1, 8, 10, 14; truthful origin/UI and capability tests. |
| 4 template/support/metadata | 1–4; complete layouts, four-extension whitelist, byte limits and predicate fixtures. |
| 5 provider conflicts/AI boundary | 4, 8, 9; projection path/hash evidence, no raw-byte shortcut, no broadcast/fetch, deterministic fallback. |
| 6–7 schema/auth/privacy | 5, 9–10; composite FKs, RLS/current membership, private exports/capabilities and hostile input tests. |
| 8–9 queue/quota/API/receipts | 6–10; races, fenced recovery, exact delivery/capture event order, immutable schemas. |
| 10–11 history/Atlas/monitoring | 9, 13–14; correction, permission withdrawal, retention and normal reserved scheduled work. |
| 12 billing/costs/prices | 6, 8, 11–12, 14; journal, per-attempt uncertainty, capture/expiry/pilot/refund tests. |
| 13–15 environments/gates/decisions | 15; isolated real resources, production mode guard, restore, final review and truthful readiness ledger. |

Self-review completed before execution: every spec section has an owning task; five Review Focus conditions have explicit tests; each exported name/types is defined in the shared contract or producing task; network/DB availability is not mistaken for red-green proof; real integration gates cannot be replaced with fixture-only success. No task authorizes a purchase, credential operation, public deployment or live payment. Task 15's external gates remain blockers until owner setup permits observation.

Execution ruling: use native task-by-task execution in this session with independent checkpoint/whole-system review where available. This preserves continuous implementation while keeping reviewers independent of the author's final assumptions. The later explicit build authorization overrides the earlier plan-review pause; owner activation decisions still stand.

## Execution milestone: provider resilience, 5 October 2026

The six-area UI, private history/team/lifecycle runtime and independent gateway/artifact attestations are committed in b2df1c7; dispatch snapshots, shared provider circuits, bounded priced retries, lost-response publication matching and real migration-runner checks are committed in e9fb702. Current full suite: 32 files / 116 tests passed without exclusions; typecheck and production web build passed; production browser 4/4 passed (22.7s). Task 8's local provider-resilience work is complete. Startup per-network registry selection, service distribution, remaining commercial/lifecycle/versioned-manifest operations, expanded acceptance tests and independent final review/source delivery remain. No task-level checkbox implies launch certification; docs/implementation-checkpoint.md is the current exact continuation record.
