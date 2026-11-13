# CB6 CPU proof image

MIT-licensed, freestanding Linux x86_64 syscall probe. It has one fixed
invocation (`/proof`), requires argc=1 and only the explicit non-secret environment keys
constructed by CB6 buildJobEnv (no inherited host environment), and contains
no runtime, interpreter, shell, libraries, credentials, or application code.

The probe checks writable `/job`, absent `/.env` and `/job/.env`, a denied
write at the filesystem root (so the owning executor must run with a read-only root,
capabilities dropped, and no-new-privileges), an immediately failed
nonblocking connection to 1.1.1.1,
cgroup-v2 `memory.max` <= 1 GiB and `pids.max` <= 256, and a fork/wait round
trip. These checks describe the executor boundary. Docker runtime must still
set a read-only root, writable `/job`, no network, the constructed job environment, and the
memory/PID ceilings. The probe cannot prove that a network namespace is
isolated merely from a failed connection. It does not test Blender and is not
a Blender runtime proof.

## Reproduction

From this directory, with WSL's installed GNU assembler and linker:

```sh
as --64 -o proof.o proof.S
ld -static -nostdlib -z noexecstack -e _start -o proof proof.o
file proof
readelf -h -l -d proof
docker build --pull=false --network=none --no-cache -t cb6-mit-proof:local .
docker image inspect cb6-mit-proof:local --format '{{json .}}'
```

The Dockerfile is `FROM scratch` and copies only the static executable. The
image build does not execute the probe. Do not run a container for this proof;
the code-built proof executor owns runtime verification.

## License

MIT License. Copyright (c) 2026 ForgeAi contributors.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions: The above copyright
notice and this permission notice shall be included in all copies or
substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT.

The cgroup helper must pass the pathname in RSI to openat. A direct helper regression with a 512-byte fixture and a 1024 ceiling returned EFAULT (exit242) before this fix and exit0 after it. This is helper evidence, not a complete container proof.
