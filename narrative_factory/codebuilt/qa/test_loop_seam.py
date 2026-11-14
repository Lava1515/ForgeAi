"""Seam damage regression. codex · gpt-6.1-sol · 2026-11-14."""
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from narrative_factory.codebuilt.qa.loop_seam import check_seam


class LoopSeamTest(unittest.TestCase):
    def test_independent_endpoint_passes_and_a_jump_fails(self):
        scratch = Path('output/temp/loop-format').resolve()
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as folder:
            a, b = Path(folder) / 'first.png', Path(folder) / 'next.png'
            pixels = np.full((160, 90, 3), 30, dtype=np.uint8)
            pixels[40:100, 20:60] = [220, 90, 35]
            Image.fromarray(pixels).save(a)
            Image.fromarray(pixels.copy()).save(b)
            self.assertTrue(check_seam(a, b)['passed'])
            Image.fromarray(np.roll(pixels, 8, axis=1)).save(b)
            result = check_seam(a, b)
            self.assertFalse(result['passed'])
            self.assertGreater(result['mae_rgb_255'], result['mae_limit'])


if __name__ == '__main__':
    unittest.main()
