"""Compose real test captures into a labeled index. No generated UI artwork."""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont
root = Path(__file__).resolve().parents[1]
folder = root / 'dist' / 'extension-verification'
report = json.loads((folder / 'fixture-report.json').read_text())
assert report['passed'] is True
font_path = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
font = ImageFont.truetype(font_path, 24)
small = ImageFont.truetype(font_path, 17)
width, cell_w, cell_h = 1500, 500, 410
canvas = Image.new('RGB', (width, 95 + cell_h * 3), '#edf0f3')
draw = ImageDraw.Draw(canvas)
draw.text((22, 10), 'にゃんぷれい v0.2.1 — ボタン・送信画面の表示確認', font=font, fill='#202124')
draw.text((22, 51), '各サイトの投稿DOMを使ったChrome拡張の試験画面です。実サイトの画面ではありません。', font=small, fill='#515b64')
for i, site in enumerate(report['sites']):
    x, y = i % 3 * cell_w, 95 + i // 3 * cell_h
    draw.text((x + 12, y + 4), site['name'], font=font, fill='#202124')
    for suffix, top in [('button', 39), ('dialog', 211)]:
        shot = Image.open(folder / f"{site['id']}-{suffix}.png").convert('RGB')
        shot.thumbnail((cell_w - 24, 168))
        canvas.paste(shot, (x + 12, y + top))
canvas.save(folder / 'overview.png')
