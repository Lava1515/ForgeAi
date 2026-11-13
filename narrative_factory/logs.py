"""
Factory logging: every line goes to stdout (docker logs) and into a ring buffer that the dashboard polls
(GET /api/logs?after=<seq>) and shows in its log drawer. Lines carry the dashboard run_id of the request
that produced them, so the drawer can file them under the right task.
"""

import collections
import contextvars
import itertools
import logging
import sys
import threading

# Set per request in server.py; each ThreadingHTTPServer request thread starts with an empty context.
run_id = contextvars.ContextVar("run_id", default=None)

_buffer = collections.deque(maxlen=2000)
_seq = itertools.count(1)
_latest = 0
_lock = threading.Lock()
_LEVELS = {"WARNING": "warn", "CRITICAL": "error"}


class _BufferHandler(logging.Handler):
    def emit(self, record):
        global _latest
        message = record.getMessage()
        if record.exc_info:
            message += "\n" + logging.Formatter().formatException(record.exc_info)
        with _lock:
            _latest = next(_seq)
            _buffer.append({
                "seq": _latest,
                "ts": record.created,
                "level": _LEVELS.get(record.levelname, record.levelname.lower()),
                "source": record.name.upper(),
                "run_id": run_id.get(),
                "message": message,
            })


def since(after: int) -> dict:
    """Lines newer than seq `after`. An `after` beyond the latest seq means the factory restarted: send everything."""
    with _lock:
        if after > _latest:
            after = 0
        return {"latest": _latest, "logs": [e for e in _buffer if e["seq"] > after]}


_root = logging.getLogger()
_root.setLevel(logging.INFO)  # third-party libraries stay at INFO; our own loggers log DEBUG too
_stdout = logging.StreamHandler(sys.stdout)
_stdout.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s [%(name)s] %(message)s", "%H:%M:%S"))
_root.addHandler(_stdout)
_root.addHandler(_BufferHandler())


def get_logger(name: str) -> logging.Logger:
    """name becomes the source badge in the dashboard (tts -> TTS)."""
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)
    return logger


if __name__ == "__main__":
    log = get_logger("test")
    token = run_id.set("run_1")
    log.debug("d")
    log.warning("w")
    run_id.reset(token)
    log.info("i")
    out = since(0)
    assert [(e["level"], e["run_id"]) for e in out["logs"]] == [("debug", "run_1"), ("warn", "run_1"), ("info", None)]
    assert since(out["latest"])["logs"] == []
    assert len(since(out["latest"] + 50)["logs"]) == 3  # restart detection
    print("ok")
