import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


TOOL = Path(__file__).with_name("render_benchmark_results.py")
JOBS = TOOL.parent.parent / "output" / "agent-jobs"


def png(path, marker=b"x"):
    # PNG signature + IHDR chunk; intentionally not a complete decodable image.
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + (13).to_bytes(4, "big") + b"IHDR"
        + (1080).to_bytes(4, "big") + (1920).to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00"
        + b"\x00\x00\x00\x00IEND"
        + marker
    )


class ResultCollectorTests(unittest.TestCase):
    def setUp(self):
        JOBS.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=JOBS)
        root = Path(self.tmp.name)
        self.jobs = JOBS
        self.job = root
        (self.job / "frames").mkdir()
        png(self.job / "frames" / "0001.png", b"one")
        png(self.job / "frames" / "0002.png", b"two")
        self.manifest = self.job / "manifest.json"
        self.manifest.write_text(json.dumps({"expected_frames": [1, 2], "frames": {
            "1": "frames/0001.png", "2": "frames/0002.png"
        }}), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, job=None, manifest=None):
        return subprocess.run([
            sys.executable, str(TOOL), "--job-dir", str(job or self.job),
            "--manifest", str(manifest or self.manifest), "--wall-times", "2,4,3",
        ], capture_output=True, text=True)

    def test_rejects_manifest_output_path_escaping_job(self):
        (self.job / "frames" / "0002.png").unlink()
        data = json.loads(self.manifest.read_text(encoding="utf-8"))
        data["frames"]["2"] = "../outside.png"
        self.manifest.write_text(json.dumps(data), encoding="utf-8")

        result = self.run_tool()

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("can't open file", result.stderr)
        self.assertFalse((self.job / "result-validation.json").exists())

    @unittest.skipUnless(hasattr(os, "link"), "hard links unavailable")
    def test_rejects_hard_linked_frame(self):
        os.link(self.job / "frames" / "0001.png", self.job / "frames" / "linked.png")
        data = json.loads(self.manifest.read_text(encoding="utf-8"))
        data["frames"]["1"] = "frames/linked.png"
        self.manifest.write_text(json.dumps(data), encoding="utf-8")

        result = self.run_tool()

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("can't open file", result.stderr)
        self.assertFalse((self.job / "result-validation.json").exists())

    def test_valid_frames_produce_hashes_and_timing_summary(self):
        result = self.run_tool()

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.job / "result-validation.json").read_text(encoding="utf-8"))
        self.assertTrue(report["validation"]["valid"])
        self.assertEqual(len(report["frames"]), 2)
        self.assertEqual(report["timing"]["median_seconds"], 3)
        self.assertEqual(report["timing"]["spread_seconds"], 2)
        self.assertIsNone(report["recommendation"])


if __name__ == "__main__":
    unittest.main()
