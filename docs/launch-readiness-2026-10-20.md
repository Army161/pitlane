# Launch readiness · 20 October 2026

Branch `feat/racing-redesign`, mirrored to `main` on github.com/Army161/pitlane. Live preview: https://pitlane-steel.vercel.app (labelled frontend preview; sign-in, inspections and payments are not connected).

## Ready and verified

| Area | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` pass (Node 24.22, pnpm 11.9) |
| Unit and integration tests | `pnpm test` 237 / 237 pass across 52 files, real isolated PostgreSQL |
| Production build | `pnpm build` pass with a 40-hex `PITLANE_BUILD_SHA`; standalone web plus packaged worker, gateway, artifact, maintenance, billing and migrator |
| Browser journeys | `pnpm test:e2e` 6 / 6 pass against the production build |
| Accessibility | axe-core 4.10.3, WCAG 2.0/2.1/2.2 A and AA plus best practice, 38 screen states at 1440 px and 390 px: 0 violations. Method and results: `docs/verification/` |
| Managed Postgres compatibility | New test `tests/integration/managed-privileges.test.ts`: all 37 migrations apply in a fresh cluster as a non-superuser administrator (the privilege shape Supabase gives `postgres`); service roles are created NOLOGIN and NOBYPASSRLS; every SECURITY DEFINER function is owned by that administrator; re-running is a no-op |
| Container recipe | The repository `Dockerfile` built a 688 MB runtime image on Linux (Docker 29.8). The only test-only overlay added the sandbox's proxy certificate and a registry mirror; the base image came from `mirror.gcr.io` because Docker Hub rate-limited the sandbox. Inside the image, `node .dist/migrate.mjs` applied all 37 migrations as a non-superuser and verified checksums on a second run. The web image in preview mode served pages, icon, share image and racing assets, and returned 503 `FRONTEND_PREVIEW` from `/health` and `/v1/*` |
| Killed-worker recovery | `service-process` test now kills with SIGKILL, so it simulates a crash on Linux as it already did on Windows (SIGTERM triggers the graceful drain). 3 / 3 consecutive passes |
| Share and tab metadata | App icon, Open Graph image with alt text, `metadataBase` from `PITLANE_ORIGIN` or the Vercel production URL, `noindex` while `PITLANE_FRONTEND_PREVIEW=true` |

## Blocked on decisions, accounts or money (launch gates)

These are required by `docs/deployment-runbook.md` and `docs/implementation-checkpoint.md`. None can be completed by source changes or automated tests.

1. **Database and auth (Supabase).** The only Supabase organization available is "Jeremy Gephart's projects" on the free plan (four paused projects). The runbook requires a user-selected organization, a dedicated project and verified production backups and restore. The free plan has no point-in-time recovery and pauses inactive projects, so production needs the Pro plan and a backup decision. Needs: organization choice and approval of the plan cost.
2. **Service hosting.** Vercel hosts only the web app. The worker, gateway, artifact, maintenance and billing services need a long-running host (Railway is the runbook candidate) with private networking. Needs: a host account and approval of its cost.
3. **Network denial proof.** On that host, demonstrate that the worker can reach only the database, gateway and artifact endpoints, then record the attestation (`PITLANE_EGRESS_VERIFIED`, `PITLANE_EGRESS_ATTESTATION_SHA256`).
4. **Two independent RPC providers.** Accounts and credentials for two authorized Solana RPC providers, with prices, configured only on the gateway.
5. **Secrets.** Restricted database logins per service (`sslmode=verify-full`), a 32-byte session key, gateway and artifact tokens and storage credentials, injected by the host. These are persistent credentials and need your approval before they are created.
6. **Sign-in email.** An authorized sending domain and verified Supabase email template before `PITLANE_AUTH_EMAIL_TEMPLATE_VERIFIED=true`. No domain has been bought.
7. **Payments.** Stay disabled (`PITLANE_BILLING_MODE=disabled`) until Stripe account ownership, prices, tax and retention, and refund terms are approved and sandbox acceptance passes.
8. **Pilot operations.** Name and staff a human pilot-review operator, and approve the pilot partial-delivery and refund terms.
9. **Real-provider and recovery evidence.** Real RPC evidence and digests, a no-broadcast network test and an authorized restore from the hosted environment.

## Deliberately not built
- Leaderboard peer confirmation: the board ranks only server-validated free lessons, so nothing self-reported needs confirming.
- Email invitations: they change who can join a workspace and depend on gate 6, so they wait for your approval and a sending domain. Membership still uses registered account IDs.
- Screen-reader testing: automated checks cannot replace a person using VoiceOver or NVDA. Keyboard, reduced-motion and axe checks pass.
