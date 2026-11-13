# Same-scene benchmark driver

The current runnable implementation is the Windows Blender 5.2 EEVEE mode. It builds a deterministic, asset-free animated sphere scene and writes all job artifacts beneath a newly created `output/agent-jobs/<job-id>` directory. It renders frames 1–12 at 1080×1920, warms up frame 1, and measures three complete repeats. Each render repeat uses two Blender processes with disjoint alternating frame assignments. It does not hold/copy frames or resume existing output.

From the canonical repository root, invoke:

```powershell
python tools/render_benchmark_driver.py --mode eevee --blender 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --job-id codex-render-benchmark
```

The driver refuses to reuse an existing job id. The job contains `trusted_scene.py`, `frozen-scene.blend`, process logs, repeat PNGs, and `settings.json`. The manifest records Blender path, blend-file hash, exact frame list, repeat durations and frame hashes. Before anything starts, the driver refuses to run when the dashboard reports an active video job (or is unreachable) or when `.superpowers/supervisor/gpu.lock` exists; it then takes that same lease directory itself and releases it at the end. The scene is built from an empty factory file with a node material, an orbiting cube and a tilted rotating sphere, so every frame differs (identical frames abort the run). Each render process records the GL device and the EEVEE sample count (64) in `device-*.json`, copied into the manifest. The warmup renders frame 1 only. Do not interpret wall times as GPU measurements or compare them to a Cycles run without collecting device and resource evidence.

`--mode cycles-gpu` and `--mode cycles-gpu-split` are exposed as explicit choices but stop before creating a job or launching a process. The existing approved-launch registry has no benchmark launch, and current activation is subject to security review. The regular executor accepts generated scene code, so using it for this trusted benchmark would require an entry-point change and review; this driver does not bypass that gate. No benchmark modes were run while the Earthstop planning lease was active.

The host subset uses Blender's bundled image decoder in separate background invocations to independently decode every PNG. GPU modes require a separately reviewed approved launcher, audited process orchestration under one `acquireGpu` lease, and container/host resource plus device capture before they can be implemented safely.
