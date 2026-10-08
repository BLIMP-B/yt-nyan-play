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
width, cell_w, cell_h = 1500, 500, 385
canvas = Image.new('RGB', (width, 95 + cell_h * 3), '#edf0f3')
draw = ImageDraw.Draw(canvas)
draw.text((22, 10), f"にゃんぷれい v{report['version']} — ボタン・送信画面の表示確認", font=font, fill='#202124')
draw.text((22, 51), '各サイトの投稿DOMを使ったChrome拡張の試験画面です。実サイトの画面ではありません。', font=small, fill='#515b64')
for i, site in enumerate(report['sites']):
    x, y = i % 3 * cell_w, 95 + i // 3 * cell_h
    draw.text((x + 12, y + 4), site['name'], font=font, fill='#202124')
    shot = Image.open(folder / f"{site['id']}-button.png").convert('RGB')
    shot.thumbnail((235, 300))
    canvas.paste(shot, (x + 12, y + 43))
    draw.text((x + 12, y + 218), 'ページの再生ボタン', font=small, fill='#515b64')
    panel = Image.open(folder / f"{site['id']}-dialog.png").convert('RGB')
    # Crop only the captured extension panel; the original PNG remains unchanged.
    panel = panel.crop((280, 65, 820, 720))
    panel.thumbnail((235, 310))
    canvas.paste(panel, (x + 255, y + 43))
canvas.save(folder / 'overview.png')
