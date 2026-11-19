# codex · gpt-6.1-sol · 2026-11-19 14:31 +02:00
from PIL import Image, ImageDraw

from narrative_factory.codebuilt.post.exposure import frame_exposure, sheet_exposure


def test_pale_black_region_and_good_sheet(tmp_path):
    pale = Image.new('RGB', (100, 180), (220, 220, 220))
    black_region = Image.new('RGB', (100, 180), (170, 170, 170))
    ImageDraw.Draw(black_region).rectangle((0, 130, 99, 179), fill='black')
    good = Image.new('RGB', (100, 180), (60, 100, 140))
    ImageDraw.Draw(good).rectangle((20, 20, 80, 150), fill=(130, 160, 190))
    assert frame_exposure(pale)['issues'] == ['pale']
    assert frame_exposure(black_region)['issues'] == ['black_region']
    sheet = Image.new('RGB', (600, 360))
    for i in range(12):
        sheet.paste(good, ((i % 6) * 100, (i // 6) * 180))
    file = tmp_path / 'sheet.png'
    sheet.save(file)
    assert sheet_exposure(file)['findings'] == []
    # A dark night/space background is not evidence of a missing fill light.
    assert frame_exposure(Image.new('RGB', (100, 180), (1, 2, 3)))['issues'] == []
