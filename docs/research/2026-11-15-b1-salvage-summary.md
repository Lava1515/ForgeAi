# B1 Unmerged Branch Salvage Summary

- **Date**: 2026-11-15 16:28 +02:00
- **Auditor**: agy · gemini-3.8-flash-high
- **Lane**: B1 (Unmerged branch salvage)
- **Reference Plan**: `ForgeBrain/plans/2026-11-15-parallel-lanes.md`
- **Current Branch / Worktree**: `t3/b1-salvage-summary` (`C:\Users\Lava\.t3\worktrees\ForgeAi\t3-5231d11f`)
- **Main Head**: `355d44897a81ad0ccd2c984cdab7e730e0065d45`

---

## 1. Executive Summary

A comprehensive forensic audit was conducted across the four historical branches designated under Lane B1:
1. `codex/job-detail-artifacts`
2. `t3/807b5801`
3. `t3/m1-fetch-baseline`
4. `t3/speed-up-codebuilt-render-pipeline`

### Key Findings
- **Zero Production Code Required to Port**: All functional code introduced across these branches is **already merged, hardened, and active on `main`**.
  - `codex/job-detail-artifacts`: Prototype artifact endpoints were merged (`1879498`, `b76da3a`) and subsequently hardened with symlink/TOCTOU security, bounded listing, and accordion polling (`0344d21`, `616bfc1`, `3775814`).
  - `t3/speed-up-codebuilt-render-pipeline`: Fenced render timing telemetry (`eb841b4`) was merged byte-for-byte as `029fcd2`. The render pipeline is **already optimized** in production on `main` via `ab72f72` (`renderloop.tune_cycles` with `use_persistent_data` and GPU denoising), cutting frame render times from 6.7 s to 0.77 s (~8.7x speedup). No port is required.
- **Unmerged Content Is Exclusively Historical Documentation**:
  - `t3/807b5801`: Contains only `docs/research/2026-11-14-branch-cleanup.md`.
  - `t3/m1-fetch-baseline`: Contains only `docs/research/2026-11-14-m1-fetch-baseline.md`.
- **Preserved Docs Are Historical Records, Not Standing Owner Orders**:
  - The branch lists and cleanup suggestions in `2026-11-14-branch-cleanup.md` reflect a stale point-in-time snapshot from 2026-11-14 (`22e7b93`); no cleanup commands should be executed.
  - The speculative acceptance test suite proposed in `2026-11-14-m1-fetch-baseline.md` is rejected under CLAUDE.md Rule 3 ("Tests only for real damage... and for bugs that actually happened"). No speculative M1 tests should be added.

---

## 2. Four Branches Forensic Breakdown

| Branch | Branch Head | Merge Base with `main` | Exact Commits | Content Type | Status vs `main` | Salvage Action |
|---|---|---|---|---|---|---|
| `codex/job-detail-artifacts` | `3083445` | `8821bbb` | `1a129c6`, `3083445` | Code | Already merged code (superseded & hardened) | None (0 lines). Unhardened prototype. |
| `t3/807b5801` | `d881f95` | `22e7b93` | `d881f95` | Research doc | Unmerged historical doc | Preserve doc as historical reference. No code to port. |
| `t3/m1-fetch-baseline` | `9628887` | `22e7b93` | `9628887` | Research doc | Code merged on `main`; doc unmerged | Preserve doc as historical reference. No code/tests to port. |
| `t3/speed-up-codebuilt-render-pipeline` | `eb841b4` | `2574c7f` | `eb841b4` | Code | Already merged code (render already optimized) | None (0 lines). Optimization already live on `main`. |

---

### 2.1 Branch 1: `codex/job-detail-artifacts`

- **Branch Head**: `3083445debf68cf8d3149d8ecb0456f39a8a1659`
- **Merge Base with `main`**: `8821bbbdf6c79911ed4e9bc32a7f100a32d70e73`
- **Exact Commits**:
  1. `1a129c6535041f37ca112784d4a28141d543f08b` (*"feat: show codebuilt job artifacts"*, 2026-11-13 20:29:36 +02:00)
  2. `3083445debf68cf8d3149d8ecb0456f39a8a1659` (*"Align artifact rounds with current visual loop and stream media"*, 2026-11-13 20:30:48 +02:00)
- **Status**: **Already merged code (and hardened/superseded)**.
- **Analysis**:
  - `1a129c6` matches `main` commit `1879498ba35959ca262ed6faf946b98088f5be76`.
  - `3083445` matches `main` commit `b76da3a30cf4853a1d528ac4a52006230db01b01`.
  - The implementation on `main` was significantly hardened across subsequent commits:
    - `0344d21`: Fixed TOCTOU symlink injection races via open file descriptor verification (`O_RDONLY | O_NOFOLLOW`, matching `dev` and `ino`), bounded listing payload size (`LIST_BUDGET`), replaced constant polling with accordion toggles (`details open`), and added unit tests (`jobArtifacts.test.js`).
    - `616bfc1`: Closed media descriptors immediately during listing and isolated tree scans.
    - `3775814`: Released pinned artifact streams upon client disconnect.
- **Salvage Verdict**: **Zero salvage value**. The branch contains an unhardened prototype. Porting any part would regress security boundaries.

---

### 2.2 Branch 2: `t3/807b5801`

- **Branch Head**: `d881f955cfa00f40f29fde14065e43a8c22f3eb0`
- **Merge Base with `main`**: `22e7b93778420379f0162de81a0e829c9921c990`
- **Exact Commit**:
  1. `d881f955cfa00f40f29fde14065e43a8c22f3eb0` (*"Research: audit local branch merged status (H1) and old-project feature coverage (H2)"*, 2026-11-14 21:15:59 +02:00)
- **Diff vs `main`**: Exactly 1 file modified: `docs/research/2026-11-14-branch-cleanup.md` (+140 lines). Zero code changes.
- **Status**: **Unmerged historical research document**.
- **Analysis**:
  - **Scope H1 (Local Branch Cleanup)**: Audited 87 local branches against `22e7b93`. This list is a point-in-time snapshot that has since drifted. Do not execute batch cleanup commands.
  - **Scope H2 (Old-Project Feature Coverage)**: Formulated the architectural baseline that `ForgeAi-old` is an ideas reference only, verified coverage of M3-M5 and P1-P5 in the modern code-built repository, and catalogued explicitly rejected legacy subsystems (admin tokens, physics loops, Etsy/n8n, ComfyUI, non-monetizable voices).
- **Salvage Verdict**: **Preserved as historical documentation only**. It does not constitute standing owner orders. Zero code to port.

---

### 2.3 Branch 3: `t3/m1-fetch-baseline`

- **Branch Head**: `962888794f7e6ef690a7c5c0494dcdea3a984f30`
- **Merge Base with `main`**: `22e7b93778420379f0162de81a0e829c9921c990`
- **Exact Commit**:
  1. `962888794f7e6ef690a7c5c0494dcdea3a984f30` (*"Research: M1 fact-check fetch timing baseline and acceptance criteria"*, 2026-11-14 21:19:33 +02:00)
- **Diff vs `main`**: Exactly 1 file modified: `docs/research/2026-11-14-m1-fetch-baseline.md` (+191 lines). Zero code changes.
- **Status**: **Production code already implemented on `main`; research doc unmerged**.
- **Analysis**:
  - The document analyzed fact-check latency bottlenecks (sequential page fetches, in-memory cache drops, redirect delays).
  - The functional optimizations recommended were implemented independently on `main` in commits:
    - `64e8595` (*"Speed up fact check page retrieval"*): Added `MAX_PARALLEL_FETCHES = 8`, `Promise.all` concurrency pooling across `response.facts`, in-flight promise caching, and deadline abort timers.
    - `56d8bb6`: Added concurrency pooling and caching to `dashboard/server/routes/storySources.js`.
    - `4b72cec` / `0ff099f`: Bounded retrieval caching and response cancellation.
  - Section 5 of the document proposed speculative offline acceptance tests (`retrievalAdapter.test.js` with mock URLs).
- **Salvage Verdict**: Under CLAUDE.md Rule 3 ("Tests only for real damage... and for bugs that actually happened"), do **NOT** add speculative M1 tests. The document is preserved as historical research; zero code or tests to port.

---

### 2.4 Branch 4: `t3/speed-up-codebuilt-render-pipeline`

- **Branch Head**: `eb841b4a5fe4c8298a6e18b64c5097a1970982b0`
- **Merge Base with `main`**: `2574c7f56b7de68cef98ee5a3791ea78798f9d8e`
- **Exact Commit**:
  1. `eb841b4a5fe4c8298a6e18b64c5097a1970982b0` (*"Record fenced render timings and effective settings"*, 2026-11-14 08:04:15 +02:00)
- **Diff vs `main`**: `blender_worker/codebuilt/renderloop.py` (+46 lines).
- **Status**: **Already merged code (and render pipeline already optimized)**.
- **Analysis**:
  - Commit `eb841b4` was merged into `main` byte-for-byte as commit `029fcd28270040253394da07c3ae7951e521dcc7`.
  - The production render speedup was subsequently built directly on top in `main`:
    - Commit `ab72f7251a5702b950c33815d645210aa79978b1` added `tune_cycles()` with `scene.render.use_persistent_data = True` and `scene.cycles.denoising_use_gpu = True` (shifting denoising from CPU OpenImageDenoise to CUDA/OptiX).
    - Commit `46284237185dde971551f3128c2a20edf5e8b27b` hardened error handling in `_save_timing` to broad `except Exception:`.
    - Commit `3acef0f` merged the reviewed render speedup changes into `main`.
  - In production benchmarks on the host RTX 4070 Ti, this optimization reduced frame render time from 6.7 s to 0.77 s (~8.7x speedup).
- **Salvage Verdict**: **Zero salvage value**. Render pipeline is already optimized on `main`. No port required.

---

## 3. Policy & Operational Guidance

1. **Already Merged Code vs Unmerged Historical Docs**:
   - `codex/job-detail-artifacts` & `t3/speed-up-codebuilt-render-pipeline`: Fully merged and superseded code.
   - `t3/807b5801` & `t3/m1-fetch-baseline`: Unmerged historical documentation.
2. **Preserved Docs Are Historical, Not Standing Orders**:
   - Historical audits reflect the codebase state at their respective snapshot times. They must not be treated as standing owner orders or triggers for speculative code changes, batch branch deletions, or artificial tests.
3. **Tests Only for Real Damage**:
   - Adhere strictly to CLAUDE.md Rule 3. Speculative M1 tests or simulated harnesses are omitted.
4. **Render Already Optimized**:
   - Render speedup is active in production on `main`; no further code port is needed for Lane B1.

---

## 4. Verification & Integrity Evidence

- **License Check**: Executed `python tools/license_check.py` — Passed: 29 entries registered and allowed.
- **Targeted Test Verification**: Executed `node --test dashboard/server/tests/jobArtifacts.test.js` — 7 passed, 0 failed.
- **Git State**: Verified clean worktree state on isolated branch `t3/b1-salvage-summary`. No modifications to production, source, or brain files.

Signed: 2026-11-15 16:28 +02:00 · agy · gemini-3.8-flash-high
