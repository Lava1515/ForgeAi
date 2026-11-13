"""Command line for the host output producer: python -I cb5_main.py <absolute job dir>.

The dashboard runs this after the offline executor container is confirmed gone. It turns <job>/frames, <job>/words.json
and <job>/mix.wav into the four CB5 output files (see cb5.produce). Prints one JSON line; exit 0 only on success.
"""
import json
import sys
from pathlib import Path

# append, never insert(0): the standard library and site-packages keep precedence over anything in the repo root.
sys.path.append(str(Path(__file__).resolve().parents[3]))

from narrative_factory.codebuilt.post import cb5, media  # noqa: E402


def main(argv):
    if len(argv) != 2:
        print(json.dumps({"status": "error", "error": "usage: cb5_main.py <absolute job dir>"}))
        return 2
    try:
        report = cb5.produce(argv[1])
    except (media.MediaError, OSError, ValueError) as error:
        print(json.dumps({"status": "error", "error": str(error)[:500]}))
        return 1
    print(json.dumps({"status": report["status"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
