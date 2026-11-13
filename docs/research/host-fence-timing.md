# Host fence timing

2026-11-13 · codex · gpt-6.1-sol

Each returned fence report records `timing.hostPhases`: `clock: monotonic_ms`,
`atMs` offsets from entry to `runIsolatedJob`, and `totalMs`. The runner saves
the report's timing as `fenceTiming` in `output/agent-jobs/.state/<jobId>.json`
for successful previews, full builds and returned failures. This state sits
outside the container's writable job mount.

Offsets are `validated`, `reaped`, `locked`, `leaseReady`, `snapshotBefore`,
`fenceReturned`, `snapshotAfter`, `resourcesSettled`, `auditComplete`.
Subtract neighbouring offsets to measure their intervals. `fenceReturned`
includes image inspection, execution and the container cleanup check. It does
not distinguish Docker startup, Blender scene construction, kit QA or frames.
Cleanup verification remains the separate authoritative `cleanup.verified` field.

Prelaunch exceptions, aborts before launch and GPU acquisition failures have no
host phase report; runner backstop failures also cannot invent one. Existing
completed jobs keep their earlier state. Timings are diagnostic only and do not
affect launch approval, timeout, audit classification, GPU leases or locks.

Validation uses simulated effects only: a missing image starts no process and
retains the ordered host phases; a returned failed fence keeps its timing in
failed job state. A live failing/passing preview comparison waits for a free GPU
and an idle dashboard restart after integration.
