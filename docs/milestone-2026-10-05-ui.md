# PITLANE UI and browser milestone

5 October 2026. This is an implementation checkpoint, not a launch claim.

- The six areas now render real scoped data: Live Garage, Crew, Service Records, Treasury, Book a Bay and Manual. Added opaque-session sign-in/out, project/workspace selection, structured predicates, expiring quotes, durable submission/cancellation, exact private exports, receipt versions/corrections/comparisons, disabled-by-default monitoring, Atlas permission controls, role management, billing/refund/ledger views and operator summary controls.
- `node node_modules/@playwright/test/cli.js test tests/e2e/journey.spec.ts`: **4 browser tests passed**, 21.8s. Booking through durable worker completion, receipt viewing and exact JSON export across all six areas; invalid address rejection and completed contradicted delivery; another workspace denied scoped reads; desktop/mobile screenshots, keyboard focus and reduced-motion checks. No browser JavaScript exceptions observed.
- `node node_modules/typescript/bin/tsc --noEmit`: **passed with no diagnostics** after all UI files were added.
- Backend latest full suite: 30 files / 95 tests passed without exclusions. Added export workspace selection regression then saw it fail against the default tenant; fixed it and `web-runtime.test.ts` now passes 2/2. Current total expected 96, full rerun pending after remaining changes.
- The Windows browser launcher uses one owned local app/worker coordinator plus an isolated real PostgreSQL cluster, with a random loopback-only shutdown capability and bounded teardown. It now exits cleanly. Idle pool errors are sanitized; pools close before the owned database is stopped.
- Desktop and mobile screenshots reviewed: `docs/screenshots/book-desktop.png`, `book-mobile.png`, `receipt-mobile.png`. Mobile navigation was subsequently adjusted so all six area links are visible; final screenshots will be regenerated.
- Production build has started; result pending. Production-browser runs, service entry points, remaining payment/lifecycle hardening, process restart/restore tests and independent review remain.
- No real provider calls, chain writes, hosted provisioning, live billing, secrets inspection or public deployment occurred. Hosted egress/backup and commercial setup remain unverified activation gates.
- Source root and branch remain as in the backend milestone. All work is preserved.

Backend milestone Library identity: `libfile_dcecbd6974cc8191899414aeb7fd568c`, version 0, file `file_00000000e7c88230a126b6d5f73fa260`. Windows does not support the returned Linux xattrs; identity is recorded here.
