"""Seamless motion helpers. Original code, codex · gpt-6.1-sol · 2026-11-14.

The cycle has N frames [0, N); N is a diagnostic endpoint, never a held video frame.
"""
import math


def phase(frame, nframes):
    """Cycle position [0, 1), including phase(N) == phase(0)."""
    if not math.isfinite(nframes) or nframes <= 0 or not math.isfinite(frame):
        raise ValueError("finite frame and positive cycle length required")
    return (frame % nframes) / nframes


def periodic(frame, nframes, low=0.0, high=1.0, cycles=1, offset=0.0):
    """Sinusoidal value, with equal value AND velocity on both sides of the seam."""
    if not isinstance(cycles, int) or cycles < 1:
        raise ValueError("cycles must be a positive integer")
    return low + (high - low) * (0.5 + 0.5 * math.sin(math.tau * (cycles * phase(frame, nframes) + offset)))


def cyclic_camera(frame, nframes, centre=(0, 0, 0), radius=8, height=4):
    """A complete orbit; pass the returned position and centre to cam.set."""
    a = math.tau * phase(frame, nframes)
    return (centre[0] + radius * math.sin(a), centre[1] - radius * math.cos(a), centre[2] + height)


def close_bake(samples):
    """Close baked scalar/vector samples by replaying them forwards then backwards.

    Both turning points use a cosine time warp (zero velocity), rather than a
    crossfade or a teleport. Capture all simulated positions/rotations together;
    sample the returned cycle(frame, nframes) from apply(). No live sim state.
    This is a stylized reversal, not a claim of unforced physical dynamics.
    """
    import numpy as np
    values = np.asarray(samples, dtype=float)
    if len(values) < 2 or not np.isfinite(values).all():
        raise ValueError("at least two finite baked samples required")
    def cycle(frame, nframes):
        x = (0.5 - 0.5 * math.cos(math.tau * phase(frame, nframes))) * (len(values) - 1)
        i = min(int(x), len(values) - 2)
        return values[i] + (values[i + 1] - values[i]) * (x - i)
    return cycle
