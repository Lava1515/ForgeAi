# B1 unmerged branch salvage summary

Original audit: agy · gemini-3.8-flash-high, 2026-11-15 16:28 +02:00.
Reviewed by claude-pro · claude-haiku-5-5 against main `355d448`.

| Branch | Branch-only commits | Evidence on main | Remaining content |
|---|---|---|---|
| `codex/job-detail-artifacts` | `1a129c6`, `3083445` | Identical patch IDs to `1879498`, `b76da3a`; hardening in `0344d21`, `616bfc1`, `3775814` | No code port needed. |
| `t3/807b5801` | `d881f95` | No equivalent document | `docs/research/2026-11-14-branch-cleanup.md`, 140 lines, exists only on this branch. |
| `t3/m1-fetch-baseline` | `9628887` | Retrieval work implemented independently in `64e8595`, `56d8bb6`, `4b72cec`, `0ff099f` | `docs/research/2026-11-14-m1-fetch-baseline.md`, 191 lines, exists only on this branch. |
| `t3/speed-up-codebuilt-render-pipeline` | `eb841b4` | Identical patch ID to `029fcd2`; later work in `ab72f72`, `4628423`, merge `3acef0f` | No code port needed. |

The branch commits themselves are not ancestors of main where the table identifies equivalent patches. Patch equivalence describes the changes, not commit identity. Main's artifact endpoint has security hardening absent from the old branch, including descriptor verification and stream cleanup.

The branch-cleanup research describes a 2026-11-14 snapshot at `22e7b93`. The M1 research describes the earlier retrieval baseline and proposes offline acceptance checks. `dashboard/server/tests/retrievalAdapter.test.js` is not on main. No decision to merge these two historical documents is recorded here. Cleanup and test decisions remain subject to current repository rules, including CLAUDE.md Rule 3 on tests for real damage and bugs that occurred.

## Render evidence limits

`ab72f72` enables persistent render data and `cycles.denoising_use_gpu`, placing the denoiser on the GPU. Its commit message cites one A/B run with 12 samples at 1080 × 1920: about 6.7 seconds per frame before changes, 6.2 seconds with persistent data alone, and 0.77 seconds with GPU denoising. The cited script is `output/agent-jobs/fable-kit-0900/speed_ab.py`, which is not in git. These are commit-message measurements from one run, not a benchmark series or a newly reproduced result. The code does not establish a CUDA/OptiX denoiser choice.

## Verification attribution

The original agy worker reported a passing licence check (29 entries) and seven passing `jobArtifacts.test.js` tests. The cross-family reviewer verified git topology, patch IDs, source hardening and seven test declarations, but did not rerun those tests. The supervisor's documentation correction adds no runtime changes. No code, branch, worktree or historical document was removed by this lane.
Updated: 2026-11-15 16:34 +02:00 · codex · gpt-6.1-sol.
