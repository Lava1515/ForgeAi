# Blender proof script. MIT License. Copyright (c) 2026 ForgeAi contributors.
# Image-resident and reviewed. Started only by /opt/forge/blender-proof* (static launcher).
# Reads nothing from /job and executes no /job content. Writes only under /job.
# Modes: render | denied | third. All paths are absolute. CPU only (no GPU is touched).
# The Blender process cap is detect-only; a renamed binary evades it. A pass here is
# one proof step, not a full isolation PASS.
import errno
import json
import os
import subprocess
import sys
import time

import bpy

JOB = '/job'
THIRD_COUNT = 2          # children spawned by 'third' (parent + 2 = three Blender processes)
THIRD_HOLD_SECONDS = 20  # children sleep at most this long; parent terminates them in finally
SECRET_WORDS = ('TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'CREDENTIAL')


def emit(mode, ok, data):
    data['mode'] = mode
    data['ok'] = ok
    data['blender_version'] = bpy.app.version_string
    print('BLENDER_PROOF_RESULT ' + json.dumps(data, sort_keys=True))
    try:
        with open(JOB + '/proof-' + mode + '.json', 'w') as fh:
            fh.write(json.dumps(data, sort_keys=True, indent=1))
    except OSError as err:
        print('BLENDER_PROOF_NOTE could not write result file: %s' % err)
    sys.stdout.flush()
    os._exit(0 if ok else 1)


def tiny_cpu_scene(size):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    return scene


def render_to(scene, filepath):
    scene.render.filepath = filepath
    try:
        bpy.ops.render.render(write_still=True)
        return None
    except Exception as err:  # reported, never hidden
        return '%s: %s' % (type(err).__name__, err)


def mode_render():
    scene = tiny_cpu_scene(64)
    out = JOB + '/out.png'
    err = render_to(scene, out)
    size = os.path.getsize(out) if os.path.exists(out) else 0
    emit('render', err is None and size > 0, {
        'output': out, 'bytes': size, 'error': err, 'resolution': [64, 64],
        'device': scene.cycles.device, 'engine': scene.render.engine,
    })


def attempt_write(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as err:
        label = 'denied' if err.errno in (errno.EROFS, errno.EACCES, errno.EPERM) else 'unexpected'
        return '%s: errno %s' % (label, err.errno)
    os.close(fd)
    try:
        os.unlink(path)
    except OSError:
        pass
    return 'WRITTEN'


def attempt_read(path):
    try:
        with open(path, 'rb') as fh:
            fh.read(1)
        return 'READABLE'
    except OSError as err:
        label = 'absent-or-denied' if err.errno in (errno.ENOENT, errno.EACCES, errno.EPERM) else 'unexpected'
        return '%s: errno %s' % (label, err.errno)


def find_env_files():
    found = []
    skip = ('/proc', '/sys', '/dev', JOB)
    count = 0
    for root, dirs, files in os.walk('/', followlinks=False):
        dirs[:] = [d for d in dirs if os.path.join(root, d) not in skip]
        count += 1
        if count > 20000:
            break
        for name in files:
            if name == '.env' or name.startswith('.env.'):
                found.append(os.path.join(root, name))
    return found


def read_limit(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError as err:
        return 'unreadable: errno %s' % err.errno


def inside_job(path):
    return path == JOB or path.startswith(JOB + '/')


def limits_match(values):
    # Fixed CPU proof approval: 2 GiB, 256 pids, 1 CPU. Missing, unbounded, malformed or different values fail.
    return values == {'memory': '2147483648', 'pids': '256', 'cpu': '100000 100000'}


def mode_denied():
    outside = {p: attempt_write(p) for p in ('/proof-outside.txt', '/opt/forge/proof-outside.txt', '/usr/proof-outside.txt', '/etc/proof-outside.txt')}
    env_reads = {p: attempt_read(p) for p in ('/.env', JOB + '/.env')}
    env_files = find_env_files()
    host_probes = {p: os.path.exists(p) for p in ('/mnt/c', '/c', 'C:/', '/mnt/host')}
    keys = sorted(os.environ.keys())
    secret_keys = [k for k in keys if any(word in k.upper() for word in SECRET_WORDS)]
    # Observation inside an already-running Blender, NOT proof of pre-Blender relative-path refusal.
    # Landing under /job or failing is acceptable; anything that exists outside /job fails this observation.
    scene = tiny_cpu_scene(16)
    candidates = (JOB + '/rel-proof-out.png', JOB + '/prev-proof-out.png', '/prev-proof-out.png', '/rel-proof-out.png')
    relative = {}
    for label, target in (('relative', 'rel-proof-out.png'), ('blend_relative', '//../prev-proof-out.png')):
        err = render_to(scene, target)
        landed = sorted(set(os.path.realpath(p) for p in candidates if os.path.exists(p)))
        relative[label] = {'target': target, 'error': err, 'landed': landed}
        for p in landed:
            if inside_job(p):
                try:
                    os.unlink(p)
                except OSError:
                    pass
    outside_landed = [p for r in relative.values() for p in r['landed'] if not inside_job(p)]
    limits = {
        'memory': read_limit('/sys/fs/cgroup/memory.max'),
        'pids': read_limit('/sys/fs/cgroup/pids.max'),
        'cpu': read_limit('/sys/fs/cgroup/cpu.max'),
    }
    ok = (
        all(v.startswith('denied') for v in outside.values())
        and all(v.startswith('absent') for v in env_reads.values())
        and not env_files and not any(host_probes.values())
        and not secret_keys and not outside_landed
        and limits_match(limits)
    )
    emit('denied', ok, {
        'outside_writes': outside, 'env_reads': env_reads, 'env_files_found': env_files,
        'host_path_probes': host_probes, 'env_keys': keys, 'secret_like_env_keys': secret_keys,
        'relative_output_observation': relative, 'pre_blender_relative_refusal_proven': False,
        'outside_job_landed': outside_landed, 'cgroup_limits': limits, 'cgroup_limits_match': limits_match(limits),
    })


def mode_third():
    # Intended to be stopped by the host executor's third-Blender detector (detect-only, cap 2).
    # The children are plain Blender processes started by exact argv (no shell). A renamed or
    # wrapped binary would evade detection; that case is not exercised here and no claim is made.
    binary = bpy.app.binary_path
    children = []
    try:
        for _ in range(THIRD_COUNT):
            children.append(subprocess.Popen(
                [binary, '--background', '--factory-startup', '--python-expr', 'import time; time.sleep(%d)' % THIRD_HOLD_SECONDS],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        deadline = time.time() + THIRD_HOLD_SECONDS
        while time.time() < deadline:
            time.sleep(0.5)
    finally:
        for child in children:
            try:
                child.terminate()
            except OSError:
                pass
        for child in children:
            try:
                child.wait(timeout=5)
            except Exception:
                try:
                    child.kill()
                except OSError:
                    pass
    emit('third', False, {'note': 'detector did not stop this run within %ds (detect-only)' % THIRD_HOLD_SECONDS, 'children': len(children)})


MODES = {'render': mode_render, 'denied': mode_denied, 'third': mode_third}


def main():
    argv = sys.argv
    mode = argv[argv.index('--') + 1] if '--' in argv and argv.index('--') + 1 < len(argv) else ''
    if mode not in MODES:
        print('BLENDER_PROOF_RESULT {"ok": false, "error": "unknown mode"}')
        sys.stdout.flush()
        os._exit(2)
    MODES[mode]()


if __name__ == '__main__':
    main()
