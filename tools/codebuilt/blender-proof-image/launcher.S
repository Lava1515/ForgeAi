/*
 * Blender proof launcher. MIT License. Copyright (c) 2026 ForgeAi contributors.
 * Linux x86_64, static, no libc, no shell. Assembled three times with
 * --defsym MODE=0|1|2 (render | denied | third).
 *
 * It only execve()s the image-resident Blender with a hard-coded argv that runs
 * the image-resident /opt/forge/proof.py. It never reads or executes /job files,
 * accepts no arguments (argc must be exactly 1), and does NOT inherit the caller's
 * environment: the environment below is hard-coded.
 */
.ifndef MODE
.error "MODE must be defined with --defsym MODE=0|1|2"
.endif
.section .rodata
d1: .asciz "/job/home"
d2: .asciz "/job/tmp"
d3: .asciz "/job/home/blender"
a0: .asciz "/opt/blender-5.2.2-linux-x64/blender"
a1: .asciz "--background"
a2: .asciz "--factory-startup"
a3: .asciz "--python"
a4: .asciz "/opt/forge/proof.py"
a5: .asciz "--"
.if MODE==0
a6: .asciz "render"
.elseif MODE==1
a6: .asciz "denied"
.else
a6: .asciz "third"
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
fail: .ascii "blender-proof launcher: execve failed or arguments given\n"
fail_end:
.section .data
argv_tab: .quad a0, a1, a2, a3, a4, a5, a6, 0
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
