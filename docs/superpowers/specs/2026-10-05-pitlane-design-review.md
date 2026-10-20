# PITLANE — design for review

5 October 2026 · Historical review summary, version 0.1 · Web first; Android/iOS later

**Superseded summary:** use [the revised v0.2 specification](2026-10-05-pitlane-design.md) and its companion implementation plan for execution. V0.2 adds bounded read-only TokenMetadata, field-scoped provider corroboration and delivery-before-capture for eligible one-off payments. This historical summary preserves the earlier review and must not be used as the current contract. Jeremy subsequently authorized end-to-end implementation; paid provisioning, credentials, public publication and live billing remain separate owner decisions.

The complete 775-line, 48,412-byte **Crypto_Agent_Venture_Framework_2026-10-04(1).md** was read through Library (`libfile_c5ff2fbdfbf88191aecabdf7df07c5b6`). This review version preserves its first-release intent and Jeremy's Railway/Supabase decisions. The full technical specification remains unchanged in [2026-10-05-pitlane-design.md](2026-10-05-pitlane-design.md), also saved as Library `libfile_bf29eec90c588191bece3dce3136031f`. That companion contains detailed table fields, threat controls, API responses, and operational limits; this document summarizes the same design.

## 1. Product and first-release boundaries

PITLANE is a Solana integration evidence service for launchpad, token-tool, and wallet-integration teams. A customer declares a supported question, receives an explicit quote, sees actual job progress, and obtains a reproducible JSON/readable receipt. A negative finding is a valid result. Missing evidence is never a pass.

The release includes authenticated accounts and projects; private tenant data; two templates; durable jobs; actual events; deterministic verification; immutable evidence and correction history; a permissioned failure/fix Atlas; quota reservations; measured costs; billing/refund adapters and ledger; explicit monitoring controls; and deployment/test contracts.

| Product area | Concrete behavior |
|---|---|
| Book a Bay | Choose project/network/mint/template and requirements; review supported scope, limitations, units and maximum charge; accept a quote. |
| Live Garage | Display real queued/running/verifying events, retries, cancellation and stale-worker state. Resume streams by event cursor. |
| Crew | Show deployed capabilities, actual worker heartbeat/load and logical stages. Label shared-process stages honestly; do not imply independent operators. |
| Service Records | Inspect/export receipts, compare observed changes, review corrections, and manage private Atlas cases. |
| Treasury | Customers see their own usage and billing. Authorized operators see source-specific costs, receipts and obligations. Test money never becomes revenue. |
| Manual | Publish the deployed checks, evidence language, API, limitations, units and policies matching each version. |

The interface uses an original garage identity and accessible responsive controls. Animation follows persisted transitions. Empty data stays empty; fixtures, sponsored/internal work and customer activity are labeled separately. AI may explain verified evidence but cannot change assertions or fabricate success.

**Excluded initially:** simulation, wallet connection, signing, broadcast, custody, payouts, token issuance, external operators/rewards, arbitrary customer scripts/URLs, cross-chain checks and mobile applications. Simulation enters only after a separate validated-path review. Token and financial expansions retain separate authorization. Newly.app, Claude Code and Cursor are optional future authoring tools, not production dependencies.

## 2. Chosen architecture

Use a **TypeScript modular monolith** in a pnpm workspace. A Railway Next.js service provides the responsive web application and `/v1` API; a separate Railway inspection worker shares versioned contracts and deterministic domain packages. Supabase supplies hosted Postgres, Auth and private Storage. Android/iOS later use the same API, authorization and billing logic.

Domain modules are identity/access, templates/rules, quoting/entitlements, jobs/scheduling, read-only providers, verification, artifacts/receipts, Atlas, costs, billing/ledger and audit. Runtime schemas generate shared types and an OpenAPI contract. Use parameterized SQL and reviewed migrations where transaction boundaries matter.

**Queue:** Postgres jobs table with transactional `FOR UPDATE SKIP LOCKED` claims, leases, fencing epochs and persisted retries. Job creation, quota reservation and enqueue commit together. No Redis service is needed. This is at-least-once execution with idempotent effects, not a claim of exactly-once external calls.

**Hosting:** Railway Railpack builds source without local Docker. Web/API and worker use the same reviewed commit and lockfile. Pin supported runtime/package versions when implementation is authorized; discovered local versions are availability evidence, not permanent version choices. A separate billing dispatcher receives payment credentials only when paid activation is authorized; inspection never receives them.

**Testing:** Vitest for deterministic rules/contracts; a real isolated hosted Postgres database for migrations, races and RLS; Playwright for browser acceptance. Local fixture mode needs Node/pnpm but no Docker, credentials or network access. Fake adapters are prohibited in production.

These choices were checked against official [Next.js deployment](https://nextjs.org/docs/app/getting-started/deploying), [Railway builds](https://docs.railway.com/builds/build-configuration), [Postgres queue locking](https://www.postgresql.org/docs/current/sql-select.html), [Vitest](https://vitest.dev/guide/) and [Playwright](https://playwright.dev/docs/intro) documentation.

## 3. Exact template and evidence contract

One unit means **one template, one mint, one explicit network, one bounded acquisition window**. Purchasing both templates consumes two quoted units. Full base58 addresses must decode to 32 bytes; symbols/abbreviations and arbitrary RPC URLs are rejected. Support `mainnet-beta` and `devnet`, with verified genesis identity and finalized observations. Do not reject valid addresses merely because they are off-curve.

### Mint configuration

Support the original SPL Token program and Token-2022 using pinned official program IDs/codecs. Record owner/program, initialized state, decimals, exact base-unit supply, mint/freeze authorities, executable flag and every extension type. Validate complete account/TLV layout, lengths, option tags and duplicate entries.

Initial Token-2022 coverage is deliberately narrow:

| Extension | Covered fields |
|---|---|
| `TransferFeeConfig` | Configuration/withdrawal authorities, withheld amount, both stored older/newer schedules: epoch, basis points and maximum base-unit fee. |
| `MintCloseAuthority` | Optional close authority. No closure attempt. |
| `MetadataPointer` | Optional pointer authority and metadata address. No metadata/URL retrieval or identity claim. |

No-extension Token-2022 mints are supported. Every other extension, including `TokenMetadata`, hooks, confidential-transfer features and unknown future types, is outside complete v1 coverage. Preserve safe partial facts but return `unsupported` execution with an `insufficient_evidence` diagnostic receipt and zero customer charge. Do not strip unknown extensions and infer compatibility. Missing/non-mint accounts and unsupported owner programs are uncharged. Malformed bytes mean insufficient evidence, not proof of maliciousness. [Official transfer-fee documentation](https://solana.com/docs/tokens/extensions/transfer-fees), [close authority](https://solana.com/docs/tokens/extensions/close-mint), [metadata pointer](https://solana.com/docs/tokens/extensions/metadata).

### Integration expectations

Accept 1–32 typed predicates: full mint/network/program equality or accepted supported-program set; exact decimals; authority equals full address/null; required/forbidden/accepted supported-extension sets; metadata-pointer equality; and token transfer-fee absence or maximum basis-point/base-unit-fee caps. Fee caps apply to **both stored schedules**, including scheduled changes. Reject contradictory requirements before reservation.

These are configuration checks. Actual transfer fees/effects, recipient-account behavior, wallet implementation, arbitrary integration code, liquidity and transaction execution are not covered. Absence of TransferFeeConfig says nothing about network or application fees.

Each assertion has `supported`, `contradicted` or `insufficient_evidence`, reason, expected/observed value and evidence references. Aggregate precedence is missing/conflicting required evidence first; otherwise any contradiction; otherwise all required assertions supported. Configuration receipts attest to reproducible observed configuration, not universal safety or investment quality.

### Sources, conflicts and prohibited capabilities

The standard customer policy requires two configured providers with distinct declared upstreams; two hostnames for one upstream do not count. A fixture policy is separately labeled and cannot become live evidence. No automatic single-source downgrade exists.

RPC tools allow only `getGenesisHash`, `getAccountInfo`, `getSlot` and optional `getBlockTime`. No arbitrary method/payload, signer, transaction, airdrop, simulation, shell or browser tool is exposed. Read-method rejection occurs before HTTP dispatch. This is an application capability boundary, not a claim that a compromised host is securely sandboxed.

Record raw successful response bodies, base64 account bytes, provider/upstream, request hash, slot, commitment and UTC acquisition time. Block time may be null. `minContextSlot` is a lower bound, not an exact historical snapshot. Equivalent bytes at different finalized slots provide limited corroboration; differing bytes remain a conflict until a bounded fresh pair resolves them. Preserve the earlier discrepancy. Unresolved conflicts/outages/staleness cannot pass. [Solana account RPC](https://solana.com/docs/rpc/http/getaccountinfo).

## 4. Durable execution, quotas and payment correctness

Quotes validate declared scope, membership and template availability without charging; expire after 10 minutes; and freeze input, rules, evidence, price and refund policy. Job submission requires the quote and an idempotency key. One transaction locks entitlement/budget rows, reserves capacity, creates the job/event and consumes the quote. Failure rolls everything back.

Same tenant/project/operation/key and same request returns the original job; different content returns 409. A canonical key also deduplicates equivalent mint/template/rule/predicate requests in a server-defined one-minute request window. That window is for deduplication, not a claimed chain snapshot. Later deliberate reruns require new quotes; no cross-tenant evidence reuse occurs.

Execution is `queued → running → verifying → completed`, with `retry_wait`, cancellation, `unsupported`, `failed` and `expired` alternatives. Incomplete inputs remain uncharged drafts. A later one-off payment flow holds `awaiting_payment` for at most 10 minutes; verified funding queues work and starts the execution deadline. Late funding after expiry is reconciled/refunded, never silently resurrected.

Proposed versioned standard bounds: 180 seconds from queue admission, 60-second lease, heartbeat every 15 seconds, at most three execution attempts, 16 total RPC calls, 8-second call timeout, 256 KiB response cap and two active jobs per project. Paired observations are acquired within 30 seconds; initial allowed skew is at most 150 slots, explicitly a product policy rather than a finality guarantee. Retries share one cost budget.

Claims increment a lease epoch. Network work happens outside database transactions. Finalization requires the current unexpired epoch; stale workers cannot publish. A reaper recovers leases or terminalizes exhausted work. Cancellation races with completion under the same locks. Request-intent and maximum cost are reserved before dispatch; a crash leaving vendor cost uncertain retains that exposure for reconciliation.

Completion atomically records receipt references, final event, quota settlement, accounting references and billing outbox identity. Supported and contradicted delivered receipts consume the same unit. Insufficient evidence, unsupported work, failure/expiry and accepted cancellation release customer units/authorizations; platform costs remain recorded. PITLANE-caused correction adds no customer charge. Idempotency tombstones persist at least 365 days; financial operation dedupe follows financial retention and outlives provider key expiry.

## 5. Data, API and tenant privacy

| Schema group | Required records and constraints |
|---|---|
| Access | Tenants, tenant/project memberships and projects. Composite foreign keys include tenant/project; current membership governs access. |
| Work | Immutable template versions, providers, quotes, jobs/attempts/events, workers, monitors/runs. Unique scoped idempotency/canonical keys and monitor/scheduled-time keys. |
| Evidence | Observations, artifacts, assertions, receipt lineages/versions/relations. Immutable published payloads; exact predecessor version; no cross-project references. |
| Allowances/costs | Entitlement lots/reservations and cost reservations/events. Nonnegative units; consumed + reserved cannot exceed grant; unique source identities. |
| Money | Payments, refunds, inbox/outbox and balanced double-entry ledger. Unique business/provider events; append-only reversals; exact integer amounts per asset/scale. |
| Knowledge/audit | Scoped permissions, Atlas case versions, audit and replay tombstones. Public reuse disabled by default. |

Large integers use decimal JSON strings and exact arithmetic. Customer USD uses cents; granular costs use micro-USD separately. Ledger balances are derived, never accepted from a client.

Core authenticated contracts: `POST /v1/quotes` takes project/template version/network/mint/predicates and returns quote/hash/expiry/units/cap/policies; `POST /v1/jobs` takes quote plus idempotency header and returns job/reservation/state; job GET/cancel/events expose scoped status and resumable events. Receipt GET supports exact version, readable form and authenticated export. Project changes compare compatible receipts. Monitor create defaults disabled; enable/disable is explicit. Atlas, usage and billing endpoints enforce their respective roles. Signed payment webhooks use a separate durable inbox. Bodies cap at 64 KiB; pagination caps at 100. Errors have stable code, safe message, request ID and retryability. Inaccessible resource IDs return non-disclosing 404s.

Receipts store full mint/network/genesis; normalized input/hash; template/rule/parser/schema/renderer/build versions; execution and finding states separately; assertions and raw artifact references; provider/upstream/slot/time/commitment; worker/verifier identities; origin, conflicts, limitations, costs and expiry; and correction lineage. Raw bodies and canonical JSON receive SHA-256 hashes. Exclude the digest itself and derived render hashes from payload hashing. A hash proves byte identity, not truth. AI text is separate and optional.

Supabase Auth tokens are validated server-side. Web uses a server-owned session/refresh boundary with secure HttpOnly cookies and CSRF protection; later mobile uses PKCE and bearer tokens in secure storage. Membership is checked per request and periodically during streams. Tenant owners/admins intentionally administer their tenant; project developers submit work; viewers read; billing-only members gain no evidence access.

RLS is deny-by-default. Runtime database roles are non-owner/no-BYPASSRLS; worker procedures validate job scope and fencing. Browser roles cannot mutate queue, quota or accounting tables directly. Storage is private; workers receive job-bound upload capabilities, customers export through an authorized API, and unrestricted storage credentials remain server-only. No customer evidence appears in public feeds, global caches or logs. Test ID guessing, cross-tenant joins/events/search, revoked sessions, capability misuse, CSRF, XSS and credential redaction. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Storage access](https://supabase.com/docs/guides/storage/security/access-control).

## 6. History, Atlas and monitoring

Publication requires uploaded bytes, verified digest and committed references. Storage/Postgres are not one transaction: pending uploads cannot create completed receipts, and unreferenced uploads are cleaned after 24 hours. Published history is append-only under application roles, not claimed cloud WORM storage.

Corrections append an exact superseding version with reason/evidence/actor; earlier versions remain accessible until retention expires. A fresh customer rerun is a new job, not a correction. Systemic false assertions pause affected templates and trigger impact review/correction.

Proposed retention: raw evidence/receipts/events 90 days; confirmed private Atlas cases and necessary evidence 365 days only under explicit permission; redacted security/idempotency records 365 days. Live financial retention requires commercial review. Deletion disables access/monitors immediately and purges eligible primary records within 30 days; backup expiry and legal financial exceptions must be disclosed. Exports show expiry; expired evidence is not claimed replayable.

Atlas defaults private. Confirmation requires reproduced failure, verified correction, regression fixture and review history. Suggested fixes remain suggestions. Tenant reuse needs explicit scope; public publication is deferred. Withdrawal blocks future reuse without promising recovery of prior exports.

Monitors are disabled until explicitly enabled with frozen scope, hourly-or-slower interval, expiry, units and cost cap. Every run uses ordinary reservation/idempotency. Restart catches up at most one missed window. Policy/price changes require renewed acceptance. Missing allowance/consent, exhausted budgets or paused rules hold monitoring without debt. Notify in-app using evidence links; external delivery needs later configured destinations.

## 7. Commercial and operating controls

Draft prices: **$199 pilot**, up to five initial plus five matching-retest units and a real human summary capped at 45 minutes; **$29/5 units**, **$99/25**, **$299/100** monthly; **$4/unit** opt-in capped overage. These are proposals, not active prices or spending authorization. Subscription grants follow confirmed billing periods. Human review delivery/refund terms need acceptance before sale.

Use a fake billing adapter locally, then separately configured Stripe sandbox. Live mode starts disabled. Hosted Checkout/Billing, capture/refund and reconciliation use durable local business identities and outbox dispatch. Signed webhooks may repeat/reorder; they cannot duplicate entitlements. Ambiguous responses remain pending reconciliation. Payment methods that cannot authorize then capture require an explicitly tested upfront-payment/refund policy. Never charge a customer or broadcast to test the system. [Stripe testing](https://docs.stripe.com/testing), [idempotency](https://docs.stripe.com/api/idempotent_requests), [webhooks](https://docs.stripe.com/webhooks).

Separate deposits, delivered-service revenue, processor/tax charges, refunds/disputes, sponsorship/financing, costs and future obligations. Token value/creator-fee assumptions are excluded from service revenue. External rewards/payouts stay off; future work liabilities have unique canonical-work identities.

Measure all requests/retries, compute, storage/egress, optional AI tokens and human minutes; preserve tariffs and actual quantities. Reconcile vendor bills through append-only adjustments. Report incremental and allocated fixed costs separately. Unknown costs stay unknown/reserved. The framework's **$1/unit** envelope and **$150 initial budget** are planning proposals; actual hosting/RPC prices and spending limits require owner approval.

## 8. Deployment readiness, gates and open decisions

Development, staging and production require different Supabase projects, Auth populations, Storage, Railway environments/services, provider/payment credentials and budget counters. Never use unrelated production databases or silent public-RPC fallbacks. Hosted test isolation replaces a Docker dependency.

Railway connection is verified with zero projects; nothing has been provisioned. Supabase read access shows four unrelated projects and only a Pro Vercel-Marketplace-managed organization. The owner must choose its Vercel provisioning/billing route or authorize a separate organization. [Supabase Marketplace guidance](https://supabase.com/docs/guides/integrations/vercel-marketplace).

Production onboarding needs custom SMTP and exact callback allowlists; default Supabase email is restricted to project-team recipients. Persistent database services use verified TLS/direct access or session pooling where IPv4 requires it. Use selected project connection details, never guessed endpoints. [SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [redirects](https://supabase.com/docs/guides/auth/redirect-urls), [database connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

Keep worker serverless/autosleep OFF. Configure graceful drain and lease recovery, bounded pools, one migration runner, compatible rolling versions, readiness and continuous heartbeats. Railway's default is On Failure with ten restarts; Always is unavailable on free/trial, so plan/cost and restart-exhaustion alerts need deliberate selection. Backups cover database **and** artifact objects; prove restoration before advertising proposed 24-hour RPO/RTO. [Restart policy](https://docs.railway.com/deployments/restart-policy), [healthchecks](https://docs.railway.com/deployments/healthchecks).

| Acceptance gate | Required proof |
|---|---|
| Determinism | Golden raw fixtures for both programs, supported combinations, malformed/unknown extensions, null authorities, integer/fee boundaries and replayed hashes. |
| Honest results | Supported input succeeds; mismatch contradicts; outage/conflict/missing evidence never passes; invalid/unsupported input consumes no customer unit. |
| Durability | Kill/restart at claim, network, upload and finalize; race leases/cancellation; lose DB/Storage. No lost accepted job or duplicate completion. |
| Financial races | At least 20 duplicate submissions and 20 competitors for the final allowance; repeated/out-of-order webhooks and ambiguous charges/refunds. One reservation/settlement per operation. |
| Privacy | Adversarial two-tenant/project-role tests for every API, stream, search, cache, capability and export; verify revocation and secret redaction. |
| History/monitoring | Correction preserves predecessor and is free for platform error; deletion/expiry is honest; disabled monitors do nothing; duplicate schedule claims and restarts stay bounded. |
| User journey | All six areas, real Book a Bay → Garage → receipt/export, negative/unavailable states, responsive/accessibility checks and truthful empty states. |
| Hosted/paid release | Independent staging, migrations/restoration, authorized two-provider real receipt, cost measurements and reviewed configuration; separate sandbox/refund/reconciliation and commercial approval before live money. |

**Only essential owner decisions remain:** (1) repository/account ownership, hosting region/plan, Supabase provisioning route, SMTP and an actual spend ceiling; (2) two authorized RPC providers/upstreams and terms; (3) commercial prices, refund/retention/payment-method/tax policy and later live billing authorization. These do not block written-spec review or subsequently authorized local deterministic work.

The immediate deliverable is this written design. Implementation planning begins only after its review.
