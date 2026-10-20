# PITLANE

Private Solana integration evidence with durable inspections, immutable receipts, scoped team access, cost accounting, agent conversations and team sprints.

The product implements two versioned templates: mint configuration and declared integration expectations. Inspection workers have no signing or transaction tools. Production activation additionally requires independently verified network restrictions. AI explanations cannot change deterministic findings or payment eligibility.

## Requirements and commands

Node 24.11.1–24.x and pnpm 11.9.0 are pinned. Install from `pnpm-lock.yaml` with `pnpm install --frozen-lockfile`.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm verify:standalone
pnpm test:e2e
```

`pnpm dev` starts an isolated, explicitly labeled local fixture workshop with embedded PostgreSQL. Fixture chain responses and payment adapters are for tests only. This command does not connect live providers. Test runs use their own database and evidence directories under `.data`.

The production build creates Next standalone output and compiled Node services in `.dist`. Hosted builds require `PITLANE_BUILD_SHA` to identify the approved source revision; the same value must be supplied at runtime. Build identity and database schema are verified before accepting work.

`pnpm verify:standalone` checks an existing build using its actual generated server, an isolated local fixture database, static assets and authentication. It records build/schema identity and cleanup results under a new `.data/standalone-<UUID>` directory.

## Product areas

- Live Garage: durable job states, recorded stage events and cancellation.
- Book a Bay: validated inputs, expiring quotes, allowance reservation and optional explicitly enabled monitoring.
- Service Records: versioned receipts, exact private JSON exports, paged history, corrections, comparisons and private Atlas reuse.
- Crew: persisted worker heartbeats, project membership and workspace administration.
- Agent workspace: persisted private conversations, selected evidence context and actual configured provider responses. Missing providers are reported as unavailable.
- Team sprints: persisted goals, assigned work, explicit status updates and optimistic concurrency.
- Treasury: entitlement periods, conservative provider budgets, payment orders, confirmed settlement, refund reconciliation and configured subscription plans.
- Manual: inspection scope and retention/payment semantics.

## Services

| Service | Command | Capability |
| --- | --- | --- |
| Web | `pnpm start` | Authentication, tenant-scoped API and UI |
| Worker | `pnpm start:worker` | Leased deterministic inspections through private services |
| Gateway | `pnpm start:gateway` | Allowlisted Solana reads and bounded provider costs |
| Artifact | `pnpm start:artifact` | Independent evidence verification and private publication |
| Billing | `pnpm billing` | Payment dispatch, webhook inbox and reconciliation |
| Maintenance | `pnpm start:maintenance` | Reaping, scheduled monitoring and retention |
| Migration job | `pnpm migrate` | Checksum-verified database migrations |

See [deployment runbook](docs/deployment-runbook.md), [no-broadcast boundary](docs/no-broadcast-boundary.md), [approved design](docs/superpowers/specs/2026-10-05-pitlane-design.md) and [collaboration amendment](docs/superpowers/specs/2026-10-05-pitlane-agent-workspace.md).

This source package is not evidence that a live deployment, payment account, RPC profile, email channel or AI provider has been configured. Acceptance results and remaining launch gates are recorded separately.
