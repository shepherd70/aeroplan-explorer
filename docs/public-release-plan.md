# Plan: taking aeroplan-explorer public

Drafted 2026-09-13. Read-only audit; nothing changed yet. Users bring their own seats.aero Pro
subscription (~$9.99/mo) — the tool never shares a key or data.

## What the audit found

| Check | Result |
|---|---|
| API key in git history | Never. `.env` was never tracked; the key's value matches 0 commits across all history. |
| Local/personal references in tracked files | One: `.claude/skills/verify/SKILL.md` names `C:\dev\aeroplan-explorer`. README's scheduler example already uses a `/home/YOU/` placeholder. |
| License | None. GitHub shows no license, so by default nobody may reuse the code. |
| CI | None. Tests run only when someone remembers `node --test`. |
| Repo settings | Private, issues on, description set, no topics. Branch protection needs a public repo or GitHub Pro — available the moment it flips. |
| Shipped data | `sample-cache.json` (756 KB) and `sample-trips.json` (192 KB) are trimmed **real seats.aero API responses**; `docs/design/itinerary-detail.md`'s appendix quotes two raw API records. Earlier versions of the samples live in history. |
| seats.aero API terms | Partner API docs: *"can be used by Pro users for non-commercial purposes and only by written agreement for commercial use"* and *"governed by the Seats.aero terms of use"* (https://seats.aero/terms — the terms page refuses automated fetches, so read it in a browser). |
| Local `.env` | Also carries stale `AMADEUS_CLIENT_ID/SECRET` lines from the removed enrichment — local-only, harmless, worth deleting. |

## Decisions (made 2026-09-13)
Chosen: **1(a)** synthetic samples with a history rewrite; **2** MIT, © Travis Shepherd; **3** as recommended. The options are kept below for the record.


1. **The sample data.** The repo redistributes seats.aero award data (small, stale, trimmed — but
   theirs). Read the terms of use with that in mind, and if they don't clearly allow it, pick:
   - **(a) Synthetic samples** — recommended. Extend `make-sample.mjs` with a `--synthetic` mode
     that emits the same schema with made-up prices/seats for a fixed set of routes and dates.
     Everything (grid, Round trips, itineraries) keeps working offline; nothing is theirs.
   - **(b) Ask seats.aero** for permission to ship a trimmed snapshot, then keep the samples.
   - **(c) No samples** — first run is `node ingest.mjs`. Simplest, weakest first impression.
   Whichever you choose, note that **git history keeps the old samples**; if the terms forbid
   redistribution, publishing this repo as-is exposes them anyway. The clean options are a
   history rewrite (`git filter-repo` on the two sample files and `docs/design/itinerary-detail.md`'s appendix)
   before flipping, or publishing from a fresh single-commit repo.
2. **License.** MIT recommended: permissive, one file, matches a zero-dependency hobby tool.
   Copyright line: your name, 2026.
3. **Name and marks.** Keep `aeroplan-explorer` (descriptive use) with a one-line disclaimer:
   not affiliated with Air Canada, Aeroplan or seats.aero; read-only; availability can be stale.
4. **Working notes in the repo.** `tasks/` and `.claude/` are visible once public. Suggested:
   keep `CLAUDE.md` and the `verify` skill (useful to contributors using Claude Code; fix the
   path), move `docs/design/itinerary-detail.md` to `docs/design/itinerary-detail.md` as a design doc, and turn
   `CHANGELOG.md` into `CHANGELOG.md` (dated entries per merged PR) so the session-specific
   review notes go away.

## Steps

### Phase 0 — before the flip (one or two PRs, plus your decisions above)
- [x] Land the fixes from the 2026-09-13 review pass (PR #10) (ten confirmed findings, all UX/consistency; none block publishing but a public first impression should not include them).
- [x] Samples are synthetic: `make-sample.mjs` now generates them (real airports, invented everything else; deterministic; `test/sample.test.mjs`). History rewritten 2026-09-13 15:03 UTC (`git filter-repo --strip-blobs-with-ids`, 7 old sample blobs removed, tip `ae9a15a` → `dfe2b99`); ask GitHub support to run garbage collection if the old blobs must be unreachable by hash sooner.
- [x] `LICENSE` (MIT).
- [x] README public pass: one-paragraph pitch with a screenshot of the Sweet-spot finder and the date grid (headless Chrome can produce them from the sample); **Prerequisites** (Node 18+, seats.aero Pro, Chrome/Edge for the file-handle flow, other browsers via the fallback picker); **Disclaimer**; **Contributing** (no dependencies, `node --test`, UI changes verified in a browser via the `verify` skill, one PR per change); link to seats.aero and its quota rules.
- [x] Generalize the path in `.claude/skills/verify/SKILL.md`; `tasks/plan.md` → `docs/design/itinerary-detail.md`; `tasks/todo.md` → `CHANGELOG.md`; this plan → `docs/`.
- [x] CI: `.github/workflows/test.yml` — `node --test` on Node 18, 20, 22 and 24 for pushes and PRs, plus `node --check` on the three scripts.
- [x] Delete the stale `AMADEUS_*` lines from your local `.env`.

### Phase 1 — the flip (your call to run; irreversible for history)
- [x] `gh repo edit --visibility public --accept-visibility-change-consequences` — public since 2026-09-13
- [x] Topics: `aeroplan`, `air-canada`, `award-travel`, `seats-aero`, `points`, `miles`, `no-build`.
- [x] Branch protection on `main`: PR required (no approvals needed), the four CI checks required and up to date, enforced for admins too, no force pushes or deletions.
- [x] Security: secret scanning + push protection, vulnerability alerts and automated security fixes enabled; Dependabot version updates for GitHub Actions via `.github/dependabot.yml` (this PR).
- [x] Tag `v1.0.0` and a GitHub release whose notes summarize the six views, the two scripts and the quota behaviour.

### Phase 2 — after
- [ ] Share where it helps (seats.aero's community, the Aeroplan subreddit) with the non-commercial framing.
- [ ] Add a short "Support" line to README: best effort; issues welcome; PRs need tests for `lib/` changes.
- [ ] Watch the first issues for the two things newcomers will hit: the Pro-only API key and the daily quota.

## Split of work
- **I can do** everything in Phase 0 except your three decisions, and can run Phase 1 on your say-so.
- **You** read the terms, pick the sample strategy and the license, and give the go for the flip.
