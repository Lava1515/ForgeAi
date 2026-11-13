/*
 * CB6 CPU fence probe. MIT License.
 * Linux x86_64, static, no runtime or external symbols. Raw syscalls only.
 * Fixed invocation: argc=1 and an empty environment are required.
 */
.section .rodata
ok:     .ascii "CB6 CPU fence checks passed\n"
ok_end:
fail:   .ascii "CB6 CPU fence check failed\n"
fail_end:
jobpath: .asciz "/job/.cb6-proof-write"
envpath: .asciz "/.env"
jobenv:  .asciz "/job/.env"
outpath: .asciz "/.cb6-proof-write"
netaddr:
        .word 2                  /* AF_INET */
        .word 0x5000             /* port 80, network byte order */
        .long 0x01010101         /* 1.1.1.1 */
        .zero 8
forkmsg: .ascii "CB6 child probe\n"
.section .text
.global _start
_start:
        /* argc == 1, argv[0], argv terminator, then envp terminator. */
        mov (%rsp), %rax
        cmp $1, %rax
        jne bad
        xor %ebp, %ebp             /* success exit status; bad sets 1 */
        lea 24(%rsp), %r15         /* envp */
env_next:
        mov (%r15), %rdi
        test %rdi, %rdi
        jz env_done
        lea allowed_env(%rip), %r14
find_env_key:
        cmpb $0, (%r14)
        je bad
        mov %rdi, %rsi
        mov %r14, %rdx
match_env_key:
        movb (%rdx), %al
        test %al, %al
        jz env_key_found
        cmpb (%rsi), %al
        jne skip_env_key
        inc %rdx
        inc %rsi
        jmp match_env_key
skip_env_key:
        cmpb $0, (%r14)
        je next_env_key
        inc %r14
        jmp skip_env_key
next_env_key:
        inc %r14
        jmp find_env_key
env_key_found:
        add $8, %r15
        jmp env_next
env_done:

        /* /job must permit create/write; remove the probe immediately. */
        mov $257, %eax             /* openat */
        mov $-100, %rdi            /* AT_FDCWD */
        lea jobpath(%rip), %rsi
        mov $0xC1, %edx            /* WRONLY|CREAT|EXCL */
        mov $0600, %r10d
        syscall
        test %rax, %rax
        js bad
        mov %rax, %r12
        mov $1, %eax               /* write */
        mov %r12, %rdi
        lea forkmsg(%rip), %rsi
        mov $16, %edx
        syscall
        cmp $16, %rax
        jne bad
        mov $3, %eax               /* close */
        mov %r12, %rdi
        syscall
        mov $87, %eax              /* unlink */
        lea jobpath(%rip), %rdi
        syscall
        test %rax, %rax
        js bad

        /* No .env is mounted at the root or under writable /job. */
        lea envpath(%rip), %rdi
        call must_be_absent
        test %rax, %rax
        jnz bad
        lea jobenv(%rip), %rdi
        call must_be_absent
        test %rax, %rax
        jnz bad

        /* Outside /job, writes must fail. */
        mov $257, %eax
        mov $-100, %rdi
        lea outpath(%rip), %rsi
        mov $0xC1, %edx
        mov $0600, %r10d
        syscall
        test %rax, %rax
        jns bad

        /* No usable external network route: nonblocking connect must fail
           immediately rather than enter EINPROGRESS. Runtime must also use
           --network=none; this probe alone cannot prove namespace policy. */
        mov $41, %eax               /* socket */
        mov $2, %edi                /* AF_INET */
        mov $0x801, %esi            /* SOCK_STREAM|SOCK_NONBLOCK */
        xor %edx, %edx
        syscall
        test %rax, %rax
        js bad
        mov %rax, %r12
        mov $42, %eax               /* connect */
        mov %r12, %rdi
        lea netaddr(%rip), %rsi
        mov $16, %edx
        syscall
        test %rax, %rax
        jns bad
        cmp $-115, %rax             /* EINPROGRESS means route exists */
        je bad
        mov $3, %eax
        mov %r12, %rdi
        syscall

        /* Bounded memory and process budget from cgroup v2. Parse a finite
           decimal prefix and require memory <= 1 GiB and pids <= 256. */
        lea mempath(%rip), %rdi
        mov $1073741824, %esi
        call limit_file_at_most
        test %rax, %rax
        jnz bad
        lea pidpath(%rip), %rdi
        mov $256, %esi
        call limit_file_at_most
        test %rax, %rax
        jnz bad

        /* A fork/wait round trip must work within the bounded PID budget. */
        mov $57, %eax               /* fork */
        syscall
        test %rax, %rax
        js bad
        jz child
        mov %rax, %r12
        sub $16, %rsp
        movq $0, (%rsp)
        mov $61, %eax               /* wait4 */
        mov %r12, %rdi
        mov %rsp, %rsi
        xor %edx, %edx
        xor %r10d, %r10d
        syscall
        cmp %r12, %rax
        jne bad
        cmpq $0, (%rsp)
        jne bad
        add $16, %rsp
        mov $1, %edi
        lea ok(%rip), %rsi
        mov $(ok_end-ok), %edx
        jmp finish
child:
        mov $60, %eax               /* exit */
        xor %edi, %edi
        syscall
must_be_absent:
        mov $257, %eax
        mov %rdi, %rsi
        mov $-100, %rdi
        mov $0, %edx
        xor %r10d, %r10d
        syscall
        cmp $-2, %rax               /* ENOENT */
        jne 1f
        xor %eax, %eax
        ret
1:      mov $1, %eax
        ret

/* rdi=file path, esi=maximum; return 0 only if finite numeric value <= max.
   Reads at most 31 bytes. "max" and missing files are rejected. */
limit_file_at_most:
        push %rbx
        push %r12
        push %r13
        push %r14
        mov %rdi, %r12
        mov %rsi, %r13
        mov %r12, %rsi             /* openat pathname, not the numeric ceiling */
        mov $257, %eax
        mov $-100, %rdi
        mov $0, %edx
        xor %r10d, %r10d
        syscall
        test %rax, %rax
        js 4f
        mov %rax, %rbx
        sub $48, %rsp
        movq $0, (%rsp)
        mov $0, %eax                /* read */
        mov %rbx, %rdi
        mov %rsp, %rsi
        mov $31, %edx
        syscall
        mov %rax, %r14
        mov $3, %eax
        mov %rbx, %rdi
        syscall
        test %r14, %r14
        jle 3f
        xor %eax, %eax
        xor %ecx, %ecx
2:      cmp %r14, %rcx
        jae 5f
        movzbq (%rsp,%rcx), %rdx
        cmp $10, %edx
        je 5f
        cmp $48, %edx
        jb 3f
        cmp $57, %edx
        ja 3f
        imul $10, %rax, %rax
        sub $48, %edx
        add %rdx, %rax
        inc %rcx
        jmp 2b
5:      cmp $0, %rcx
        je 3f
        cmp %r13, %rax
        ja 3f
        xor %eax, %eax
        jmp 6f
3:      mov $1, %eax
6:      add $48, %rsp
4:      pop %r14
        pop %r13
        pop %r12
        pop %rbx
        ret
bad:
        mov $1, %ebp
        mov $1, %edi
        lea fail(%rip), %rsi
        mov $(fail_end-fail), %edx
finish:
        mov $1, %eax                /* write */
        mov $2, %edi
        syscall
        mov $60, %eax               /* exit */
        mov %ebp, %edi
        syscall
.section .rodata
mempath: .asciz "/sys/fs/cgroup/memory.max"
pidpath: .asciz "/sys/fs/cgroup/pids.max"

/* buildJobEnv's explicit non-secret key allowlist. Values are constructed by
 * the host; inspecting the actual Docker argv remains executor evidence. */
allowed_env:
        .asciz "HOSTNAME=", "PATH=", "HOME=", "TEMP=", "TMP=", "TMPDIR=", "FORGEAI_TEST_TMP=", "FORGEAI_JOB_ID=", "FORGEAI_JOB_DIR=", "PYTHONNOUSERSITE=", "PYTHONDONTWRITEBYTECODE=", "LANG=", "LC_ALL=", "TZ="
        .byte 0
