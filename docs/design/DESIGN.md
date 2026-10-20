# PITLANE design system: racing evidence workshop

Approved direction: an original stock-car race-control workspace (audit approach A) with the optional career layer (approach B). It was built to match the six owner-supplied reference concepts (landing, onboarding, dashboard, inspection setup, evidence report, career garage). Structure was adapted from the motorsport DESIGN.md pattern (near-black canvas, full-bleed automotive photography, a sparing signature stripe). No other brand's marks, liveries or names are used. PITLANE is not affiliated with NASCAR or any team.

## Principles
1. **Plain English first, racing second.** Every racing label sits beside a functional one (Race control · Dashboard, Book a Bay · New inspection, My garage · Learning and cosmetics).
2. **Evidence is ivory, the world is asphalt.** Reports, forms and money appear on warm ivory panels with dark ink. The garage, track and navigation are charcoal.
3. **Execution is not the finding.** Job state (flags, track stages) and finding (supported / contradicted / insufficient evidence) are always shown separately, with literal words beside any colour or icon.
4. **Cosmetics never touch the core.** Livery, number plate and lighting change appearance only. Unlocks come only from free, server-validated, deduplicated lessons.
5. **No invented activity.** Empty, loading, unavailable and revoked states are designed. There are no sample podiums, fake people or simulated live data. Illustrations on the public page are labelled as examples.

## Tokens (apps/web/src/app/racing.css)
| Token | Value | Use |
|---|---|---|
| `--asphalt` | `#0c0f12` | Page canvas |
| `--carbon` | `#161b20` | Dark panels |
| `--rail` | `#28313a` | Dark borders |
| `--ivory` | `#f4efe6` | Evidence, form and money panels |
| `--ink` | `#14181c` | Text on ivory |
| `--orange` | `#ff6a1a` | Primary actions (dark text on top) |
| `--orange-ink` | `#b13e06` | Orange text on ivory (AA) |
| `--orange-on-dark` | `#ff8a4c` | Orange text on asphalt (AA) |
| `--go` / `--go-ink` | `#1f9d57` / `#17663a` | Job complete, requirement met |
| `--caution-ink` | `#7d5200` | Insufficient evidence, paused states |

Type: Anton (OFL, self-hosted Latin subset) for display headings; system UI sans for body; monospace for addresses, hashes and IDs. Radius 10px for panels, 6px for controls. Gutter 24px (16px on phones). Minimum touch target 44px.

## Imagery
- `public/racing/garage-27-*.webp`: the original #27 stock car in a pit garage (owner-generated concept art; source PNG in `docs/design/racing-source/`).
- `public/racing/learning-track-*.webp`: original aerial track used for the learning map and workflow band.
- All photographs are decorative (`alt=""`) and hidden when the "Racing imagery" preference is off. Every screen states its content in text.

## Components
App shell with icon sidebar, topbar with workspace and project switchers, `RaceHero` photo band, stat tiles (labelled "in the latest 25"), recent-inspections table, live job track (queued → running → verifying → completed, with branch notes for retry_wait, awaiting_payment, failed, cancelled, unsupported and expired), requirement quick-add cards, scope review panel, evidence summary table, finding and execution status cards, provider observation log, career scene, learning track map (with a list equivalent), cosmetic upgrade rows, opt-in board card, onboarding stepper, role cards and preference switches (racing imagery, reduce motion).

## Accessibility
- Skip link, landmark navigation, `aria-current` on the active area and step.
- The career views use a keyboard tab pattern (arrow keys) and keep the open view in the URL (`?view=track`).
- Help text is linked with `aria-describedby`, not placed inside labels.
- Live updates announce through `role=status` and `role=alert`.
- `prefers-reduced-motion` is honoured, plus a persistent in-app "Reduce motion" switch.
- Colour never carries meaning alone: every finding has a word and a shape.
