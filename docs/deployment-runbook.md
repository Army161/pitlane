# Deployment runbook

## Topology

Deploy one immutable source revision as separate web, worker, gateway, artifact, billing and maintenance services. PostgreSQL stores durable jobs, leases, outboxes, membership, cost intents and collaboration records. A private Supabase bucket stores immutable evidence bytes. Supabase Auth supplies verified identities; PITLANE browser sessions remain opaque HttpOnly cookies.

Railway is a candidate host, not a verified network boundary. Before production inspection, demonstrate that the worker can reach only its required database, gateway and artifact endpoints and cannot reach arbitrary RPC or Internet destinations. Internal HTTPS endpoints must present valid certificates. Do not set egress-verification flags merely to bypass startup checks.

## Build and release

1. Review and commit the exact source, lockfile and migrations. Set `PITLANE_BUILD_SHA` to that commit's complete SHA.
2. Install the pinned lockfile, run typecheck and all tests, then build with the same SHA. Preserve `.dist/build-manifest.json` with release evidence.
3. Apply migrations once using the isolated migrator identity. Never edit an already applied migration. Verify the runtime contract and schema version match the compiled release.
4. Provision separate restricted database login identities, each granted only its corresponding `pitlane_*` role. No application login may be a superuser, bypass RLS, receive direct table writes or hold another service role. Remote database URLs require `sslmode=verify-full` and a trusted CA.
5. Configure the runtime row, environment identity, exact Supabase project, provider registry and explicit cost budgets through the operator provisioning process. Do not seed local fixtures in a hosted environment.
6. Deploy private gateway, artifact, maintenance and worker services; expose only the web application and the signed billing webhook endpoint as required. Start payments disabled.
7. Verify readiness, authentication, tenant isolation, a real read-only devnet inspection, receipt download/digest, cancellation, crash recovery and deletion. Separately verify production TLS, network denial and recovery.

The included Dockerfile is a deployment recipe. Its successful container build and Linux shutdown behavior must be verified on the target builder before release. Windows local process checks do not establish Linux behavior.

## Configuration by service

All hosted services require `PITLANE_MODE=staging` or `production`, `PITLANE_ENVIRONMENT_ID`, `PITLANE_EXPECTED_PROJECT_ID`, `PITLANE_BUILD_SHA`, and matching authentication/storage/RPC/billing modes. Runtime environment values must agree with the database runtime record. Production also requires `PITLANE_EGRESS_VERIFIED=true` and `PITLANE_EGRESS_ATTESTATION_SHA256` tied to retained verification evidence.

| Service | Required private configuration |
| --- | --- |
| Web | `PITLANE_WEB_DATABASE_URL`, `PITLANE_AUTH_DATABASE_URL`, HTTPS `PITLANE_ORIGIN`, 32-byte hex `PITLANE_SESSION_KEY_HEX`, Supabase URL/publishable key, private storage credentials |
| Worker | `PITLANE_WORKER_DATABASE_URL`, gateway URL/token, artifact API URL/token, `PITLANE_WORKER_PROVIDERS` containing identities/pricing only |
| Gateway | `PITLANE_GATEWAY_DATABASE_URL`, gateway token, `PITLANE_GATEWAY_PROFILES` containing the two independent upstream endpoints/credentials per configured network |
| Artifact | `PITLANE_ARTIFACT_DATABASE_URL`, artifact API token, private Supabase storage credentials |
| Billing | `PITLANE_BILLING_DATABASE_URL`; when enabled, Stripe secret, webhook secret, account ID, trusted origin and immutable versioned catalog |
| Maintenance | `PITLANE_MAINTENANCE_DATABASE_URL`, private storage credentials |
| Migrator | `PITLANE_MIGRATOR_DATABASE_URL`; never distribute this identity to application services |

Storage credentials are `PITLANE_SUPABASE_URL`, `PITLANE_STORAGE_SECRET_KEY`, `PITLANE_STORAGE_BUCKET` (default `pitlane-private`) and exact project identity. Private-bucket checks run at startup. The worker receives neither storage master credentials, upstream credentials nor payment secrets.

Email sign-in requires the approved Supabase email template/callback flow and successful verification before setting `PITLANE_AUTH_EMAIL_TEMPLATE_VERIFIED=true`. Use an authorized sending domain and test delivery. No SMTP credentials or production secrets belong in source, build logs or source archives.

## Agent configuration

AI is optional and disabled without a real provider and explicit allowance. The web service accepts `PITLANE_AI_MODE=openai`, `PITLANE_OPENAI_API_KEY`, `PITLANE_OPENAI_MODEL` and `PITLANE_AI_ALLOWANCE_JSON`. The allowance must specify integer `dailyRequests`, `dailyTokens`, `dailyCostMicro`, `inputMicroPerMillion` and `outputMicroPerMillion` based on the actual approved provider/model rates. Do not invent prices.

Requests use the fixed OpenAI Responses endpoint with bounded selected context, no execution tools and no automatic retry after uncertain provider delivery. AI token/cost accounting is separate from deterministic inspection accounting. An unavailable provider still allows a user message to be saved, with an explicit unavailable status.

## Billing activation

Pending launch prerequisites: name and staff a human pilot-review operator, and obtain approval of the pilot partial-delivery and refund terms. Neither staffing nor commercial approval is automated or established by the local acceptance suite.

Keep `PITLANE_BILLING_MODE=disabled` until account ownership, product prices, tax/financial retention, refund terms and sandbox acceptance have been approved. Only the billing service receives Stripe credentials. The web app records commands and cannot dispatch charges directly.

`config/billing-catalog.schema.json` defines immutable plan versions. A plan binds its provider account, price, USD amount, units and monthly interval. Checkout completion alone does not grant allowance; confirmed invoice reconciliation grants its real period. Pilot checkout requires approved partial-delivery/refund policy and a human operator capable of delivering the promised review. Do not market an unstaffed review as automated delivery.

## Recovery and acceptance

`scripts/retention-backup.ts` exercises a bounded logical snapshot plus exact migration sources and retained object bytes in isolated local databases. It is not a substitute for managed production point-in-time recovery. Verify database backup policy, bucket retention/recovery and a real authorized restore before claiming production recovery targets.

Release acceptance must retain: source identity, dependency lockfile, schema checksums, test/build results, browser screenshots, no-broadcast network test, real RPC evidence/digests, provider account identities, payment sandbox evidence and restore evidence. Pending external checks are launch gates, never marked as completed by source tests.
