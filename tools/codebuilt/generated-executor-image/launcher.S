/*
 * Generated-code executor launcher. MIT License. Copyright (c) 2026 ForgeAi contributors.
 * Linux x86_64, static, no libc, no shell.
 *
 * It only execve()s the image-resident Blender with a hard-coded argv that runs the image-resident
 * /opt/forge/entry.py. That entry script runs the planner's build script from the job folder: this launcher is the
 * reviewed fixed program, the build script is the generated code, and the container (read-only root, network none, no
 * credential, no .env, bounded pids/memory/cpu) is the fence around it. The launcher itself never reads or names any
 * /job file in its argv, accepts no arguments (argc must be exactly 1), and does NOT inherit the caller's
 * environment: the environment below is hard-coded.
 *
 * Assembled twice (Dockerfile stage 1). As is, it is the CPU launcher. With `as --defsym GPU=1` the only difference is the
 * entry script, /opt/forge/entry_gpu.py, which selects the CUDA/OptiX device and fails closed before the build script runs.
 */
.section .rodata
d1: .asciz "/job/home"
d2: .asciz "/job/tmp"
d3: .asciz "/job/home/blender"
a0: .asciz "/opt/blender-5.2.2-linux-x64/blender"
a1: .asciz "--background"
a2: .asciz "--factory-startup"
a3: .asciz "--python"
.ifdef GPU
a4: .asciz "/opt/forge/entry_gpu.py"
.else
a4: .asciz "/opt/forge/entry.py"
.endif
e0: .asciz "HOME=/job/home"
e1: .asciz "TMPDIR=/job/tmp"
e2: .asciz "TEMP=/job/tmp"
e3: .asciz "TMP=/job/tmp"
e4: .asciz "BLENDER_USER_RESOURCES=/job/home/blender"
e5: .asciz "PATH=/usr/bin:/bin"
e6: .asciz "LANG=C.UTF-8"
e7: .asciz "PYTHONNOUSERSITE=1"
e8: .asciz "PYTHONDONTWRITEBYTECODE=1"
fail: .ascii "blender-generated launcher: execve failed or arguments given\n"
fail_end:
.section .data
argv_tab: .quad a0, a1, a2, a3, a4, 0
envp_tab: .quad e0, e1, e2, e3, e4, e5, e6, e7, e8, 0
.section .text
.global _start
_start:
        cmpq $1, (%rsp)             /* argc must be exactly 1 */
        jne bad
        mov $83, %eax               /* mkdir, errors (EEXIST, EROFS) ignored */
        lea d1(%rip), %rdi
        mov $0700, %esi
        syscall
        mov $83, %eax
        lea d2(%rip), %rdi
        mov $0700, %esi
        syscall
        mov $83, %eax
        lea d3(%rip), %rdi
        mov $0700, %esi
        syscall
        mov $59, %eax               /* execve(a0, argv_tab, envp_tab) */
        lea a0(%rip), %rdi
        lea argv_tab(%rip), %rsi
        lea envp_tab(%rip), %rdx
        syscall
bad:
        mov $1, %eax                /* write */
        mov $2, %edi
        lea fail(%rip), %rsi
        mov $(fail_end-fail), %edx
        syscall
        mov $60, %eax               /* exit(127) */
        mov $127, %edi
        syscall
