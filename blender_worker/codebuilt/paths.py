"""Absolute-path guard. A relative Blender output path once wrote previews to C:/prev."""
import os
from pathlib import Path

JOB_ROOT = Path("C:/code/ForgeAi/output/agent-jobs")


def require_abs(path):
    p = os.fspath(path)
    if not os.path.isabs(p):
        raise ValueError(f"path must be absolute: {p!r}")
    return p


def require_job_dir(path):
    """Require a resolved child of the owner's dedicated local job root."""
    p = Path(require_abs(path)).resolve()
    root = JOB_ROOT.resolve()
    if p == root or not p.is_relative_to(root):
        raise ValueError("job directory must be inside the dedicated agent-jobs root")
    return str(p)
