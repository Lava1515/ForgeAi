# CB6 Blender proof image (source + provenance)

Image `cb6-blender-proof:sol1927`, id `sha256:44b3875c3bd6e4acb9c921e1ac720cf7268c6951126ab2c978b6cc732238f836`
(linux/amd64, 1.53 GB). Built 2026-11-12, **never run**. CPU only, no GPU, no ffmpeg, no shell ENTRYPOINT.
The image is a local artifact; it is not in git.

## Fixed commands (the only approved-argv candidates)
Each is a static MIT launcher that execve()s Blender with a hard-coded argv and a hard-coded environment.
It takes no arguments (argc must be 1), never reads `/job`, and no argv contains `/job`.

| Command | Hard-coded Blender argv tail | Purpose |
|---|---|---|
| `["/opt/forge/blender-proof"]` | `--background --factory-startup --python /opt/forge/proof.py -- render` | one 64x64 Cycles CPU render to `/job/out.png`; version recorded |
| `["/opt/forge/blender-proof-denied"]` | `... -- denied` | outside writes (`/`, `/opt/forge`, `/usr`, `/etc`), `/.env` and `/job/.env`, `.env` walk, host path probes, env keys, relative and `//../` render output, cgroup limits |
| `["/opt/forge/blender-proof-third"]` | `... -- third` | parent starts two child Blender processes (three in total) so the host detector with `maxBlender: 2` can flag `third_blender`; kept separate so `render` can finish |

argv[0] is `/opt/blender-5.2.2-linux-x64/blender`. Hard-coded env: `HOME=/job/home TMPDIR=/job/tmp TEMP=/job/tmp
TMP=/job/tmp BLENDER_USER_RESOURCES=/job/home/blender PATH=/usr/bin:/bin LANG=C.UTF-8 PYTHONNOUSERSITE=1
PYTHONDONTWRITEBYTECODE=1`. The launcher mkdirs `/job/home`, `/job/tmp`, `/job/home/blender` (errors ignored).
Names are not matched by `INTERPRETER_RE` (`blender-proof*` is not an exact `blender`). Policy and approval code are unchanged.

## Honest limits
- The Blender cap is detect-only. A renamed or wrapped binary evades it; no mode here exercises that, and none claims it.
- `proof.py` only checks what is visible inside the container. A pass is one proof step, not a full isolation PASS.
  Outside-write audit of the host still depends on the host watch roots.
- Real agent stays off. Nothing here approves, activates or enables a launch; the review gate is unchanged.
- Blender headless library completeness and every mode's behaviour are **unproven until a run**.

## Provenance
| Part | Pin | Licence |
|---|---|---|
| Base | Docker Official `debian` bookworm-slim linux/amd64 manifest `sha256:c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018` (both stages) | Debian mix (DFSG) |
| Blender | https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz, SHA-256 `84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168` (matches official `blender-5.2.2.sha256`; re-checked by `sha256sum -c` inside the build) | GPL-3.0-or-later (tool, outputs are ours) |
| X/GL runtime (apt, signed) | libx11-6 2:1.8.4-2+deb12u2, libxi6 2:1.8-1+b1, libxxf86vm1 1:1.1.4-1+b2, libxfixes3 1:6.0.0-2, libxrender1 1:0.9.10-1.1, libxkbcommon0 1.5.0-1, libsm6 2:1.2.3-1, libice6 2:1.0.10-1, libgl1/libegl1/libglvnd0/libglx0 1.6.0-1, libxext6 1:1.3.4-1+b1, libdbus-1-3 1.14.10-1~deb12u1 (libc6 2.36-9+deb12u14) | various FOSS |
| Launcher, proof.py | this directory | MIT |
| Build-only | `binutils` in the throwaway `asm` stage; not shipped | GPL tool, not in image |

apt versions float within bookworm at build time; the image id is the immutable pin. Build-time network was used only by apt.
Licence basis: ForgeBrain decision 2026-11-12-blender-proof-tool-runtime-taken (KAN-257 Blender tool exception plus the
necessary pinned headless runtime; not distributed, not in video assets; asset/dependency policy MIT/Apache/CC0 unchanged).
This is a taken decision the owner may veto. Launcher sha256: blender-proof `2b987fef…11d7`, -denied `450be7ba…50c5`, -third `bb4d7b81…996e`.

## Build (no container is started)
Stage a scratch context with `Dockerfile`, `launcher.S`, `proof.py`, the verified tarball and a `.dockerignore` allowlist, then:
```sh
docker build --pull=false -t cb6-blender-proof:sol1927 .
docker image inspect cb6-blender-proof:sol1927 --format '{{.Id}}'
```
Do not run the image by hand; the proof executor owns runtime verification.

## Test (static source invariants only)
```sh
node --test tools/codebuilt/blender-proof-image/image-source.test.mjs
```

MIT License. Copyright (c) 2026 ForgeAi contributors. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated files, to deal in the Software without restriction, subject to the copyright notice and this permission notice being included. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

## 2026-11-12 19:39 +02:00 · codex · gpt-6.1-sol · reviewed proof criteria correction
Candidate image sha256:395f1052b85c04ebcbea9c2e2f6ecd92604b82b094b9c56dbcfebe05eb6e1a2f (cb6-blender-proof:sol1940) supersedes44b3875c for proposed launch. Still never run and not approved. Same verified tarball/base/libs/static launchers; proof.py changed. Rebuild log C:/code/ForgeAi/output/agent-jobs/sol1940-blender-proof-fix/build-final.log used cached package stages. Earlier network-none full rebuild failed apt, and FROM image-id derivation failed resolution; neither produced or ran a container.
Denied mode now requires exact cgroup2 memory2147483648, pids256, cpu100000/100000, corresponding to 2048MiB/1CPU/256pids launch limits. Unexpected .env read errors fail; only ENOENT/EACCES/EPERM count as absent or denied. Outside-write errors require EROFS/EACCES/EPERM. Relative-path rendering is labeled observation only; pre-Blender refusal is not proven by this script.
Python behavior checks3pass after observed red unexpected-error/cgroup cases; source checks9pass. Candidate render and denied launchers need independent security review. The third launcher stays unapproved pending baseline Blender resource measurements and a separate bounded detector-run decision. The host GPU lease remains mandatory when approved blender.max is2 even if gpu=false. Realagent disabled.
