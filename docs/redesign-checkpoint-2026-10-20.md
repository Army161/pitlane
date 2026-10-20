# Racing redesign checkpoint · 20 October 2026

Branch `feat/racing-redesign` (also `main` on github.com/Army161/pitlane). Base: accepted v1 source `4f04a6ee` (schema 036). This change adds schema 037 (career learning and cosmetics).

## What changed
- Public landing page explains the product before sign-in: who it is for, what you enter, what you receive and its limits, plus the 100-token transfer-fee worked example (labelled illustrative).
- Onboarding: workspace → role → first inspection. The workspace and project are real records. The role is a browser-only tip preference. Progress resumes after an interruption.
- Race control (dashboard): stats labelled "latest 25", real report outcomes joined from receipt history, a live job track with branch notes for every non-happy state, and an "On deck" checklist derived only from real data.
- Book a Bay: quick-add requirement presets that prefill the existing structured predicates (transfer fee, mint authority, freeze authority, metadata name), inline explanations, and a scope and pricing review before the quote. Declaration → quote → explicit submit is unchanged.
- Inspection report: job (execution) and finding status cards shown separately, evidence summary first, "What this means", and a provider observation log built from recorded reads. All previous detail, export, version history, comparison and correction controls are retained.
- My garage (career): six free lessons validated server-side and recorded once. Cosmetic livery, number plate and lighting unlock only from lessons and are re-checked in the database. Track map with a list equivalent. Opt-in workspace leaderboard, off by default, with published metric rules and honest empty states.
- Theme applied to crew, agents, sprints, treasury and manual. The manual gains "Start here".

## Invariants preserved
No changes to inspection logic, providers, evidence, receipts, quotas, prices, billing, permissions, retention or release gates. Career data cannot read or write jobs, findings, entitlements or billing (`037_career.sql`, SECURITY DEFINER functions, no direct table grants). It is erased on membership revocation and tenant deletion. Supported, contradicted and insufficient-evidence findings remain literal and visible.

## Verification (Linux container, Node 24.22, pnpm 11.9)
| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm test` | 235 / 236 pass. The one failure, `service-process` "recovers a killed owned worker", fails identically on untouched `4f04a6ee` in this environment (the job completes before the kill; timing). |
| `pnpm build` (`PITLANE_BUILD_SHA` set) | pass |
| `pnpm test:e2e` (production build) | 6 / 6 pass (original 5 plus a new landing/onboarding/career journey) |

## Hosting status
The Vercel project serves the web UI as a labelled frontend preview (`PITLANE_FRONTEND_PREVIEW=true`). Sign-in, inspections and payments return an explicit "not connected" response. No database, workers, gateway, artifact or billing services are hosted, and real billing stays disabled. All launch gates in ACCEPTANCE remain open: dedicated Supabase organization and cost approval, restricted roles and secrets, two authorized RPC providers, proof of worker network denial, Linux container acceptance, auth/email, payment and recovery acceptance, a staffed human pilot reviewer, and approved refund terms.

## Not done
- No peer-confirmation workflow: the leaderboard ranks only free lessons completed, by design.
- No email invitations (membership still uses registered account IDs).
- The redesign was not tested with a screen reader or measured for contrast with a tool. Keyboard and reduced-motion paths were checked in the browser tests.
