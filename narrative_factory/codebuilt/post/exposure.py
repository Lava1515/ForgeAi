"""Advisory exposure measurements; never a QA gate.

codex · gpt-6.1-sol · 2026-11-19 14:31 +02:00
Calibrated against the two Sonnet proof-day drafts and tools-demo shorts.
"""
import json
import sys

from PIL import Image, ImageStat


def frame_exposure(image):
    grey = image.convert('L')
    stats = ImageStat.Stat(grey)
    mean, contrast = stats.mean[0] / 255, stats.stddev[0] / 255
    hist = grey.histogram()
    black_share = sum(hist[:3]) / sum(hist)  # <= 2/255; avoids dark blue night/space skies
    issues = []
    if mean >= 0.72 and contrast <= 0.14:
        issues.append('pale')
    # Only warn in otherwise bright frames: intentionally dark scenes are ambiguous.
    if mean >= 0.35 and black_share >= 0.20:
        issues.append('black_region')
    return {'mean': round(mean, 4), 'contrast': round(contrast, 4),
            'black_share': round(black_share, 4), 'issues': issues}


def sheet_exposure(file, cols=6, rows=2):
    """The final CB5 sheet is twelve tiles, six columns, with no header."""
    findings, tiles = [], []
    with Image.open(file, formats=['PNG', 'JPEG']) as sheet:
        w, h = sheet.size
        for i in range(cols * rows):
            box = (i % cols * w // cols, i // cols * h // rows,
                   (i % cols + 1) * w // cols, (i // cols + 1) * h // rows)
            tile = frame_exposure(sheet.crop(box))
            tiles.append({'tile': i + 1, **tile})
            for issue in tile['issues']:
                message = ('is washed out; lower exposure or use a darker sky' if issue == 'pale'
                           else 'has a large black region; check the surface and add fill light')
                findings.append(f'final-sheet tile {i + 1} {message}')
    return {'tiles': tiles, 'findings': findings}


if __name__ == '__main__':
    try:
        print(json.dumps(sheet_exposure(sys.argv[1])))
    except Exception:
        # This measurement must never prevent a draft, including on unreadable sheets.
        print(json.dumps({'findings': [], 'unavailable': True}))
