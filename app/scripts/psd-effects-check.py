#!/usr/bin/env python3
# レイヤー効果の再現度を確かめる。
# 先に Vite を 5175 番で起動しておく：cd app && npx vite --port 5175
# 使い方：python3 scripts/psd-effects-check.py [fixture名 ...]
# app/psd-fixtures/<名前>.psd と（あれば）<名前>.png（Photoshop の合成画像）を比べる。
# 差の画像は /tmp/psd-effects-diff/<名前>.png（見本 | 効果あり | 差×4 | 効果なし）、原寸の結果は <名前>-after.png、見本は /tmp/ref-<名前>.png
# 引数なしなら 3000×4000 での速さも測る

import base64
import json
import os
import sys

from playwright.sync_api import sync_playwright

FIXTURES = [
    'fx-effects',
    'fx-rw-effects',
    'fx-blend-mode',
    'fx-group-drop-shadows',
    'fx-multiple-strokes',
    'fx-rw-strokes',
    'fx-text-carriage-return',
    'fx-2026-blend-modes',
    'fx-pattern',
    'fx-gradient-overlay',
]
OUT = '/tmp/psd-effects-diff'
URL = os.environ.get('PSD_TEST_URL', 'http://localhost:5175/psd-effects-test.html')


def main() -> None:
    names = sys.argv[1:] or FIXTURES
    os.makedirs(OUT, exist_ok=True)
    rows = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        page = browser.new_page()
        page.on('console', lambda m: print('[console]', m.text) if m.type == 'error' else None)
        page.goto(URL)
        page.wait_for_selector('body[data-ready="1"]', state='attached', timeout=60000)
        for name in names:
            try:
                r = page.evaluate('n => window.runFixture(n)', name)
            except Exception as e:  # noqa: BLE001
                print(f'{name}: 失敗 {e}')
                continue
            head, data = r['image'].split(',', 1)
            with open(os.path.join(OUT, f'{name}.png'), 'wb') as f:
                f.write(base64.b64decode(data))
            with open(os.path.join(OUT, f'{name}-after.png'), 'wb') as f:
                f.write(base64.b64decode(r['full'].split(',', 1)[1]))
            del r['image']
            with open(f'/tmp/ref-{name}.png', 'wb') as f:
                f.write(base64.b64decode(r['refFull'].split(',', 1)[1]))
            del r['full']
            del r['refFull']
            rows.append(r)
        if not sys.argv[1:]:
            print('perf 3000x4000 (ms):', page.evaluate('window.perfTest()'))
        browser.close()
    print(f"{'fixture':26} {'size':>11} | {'before MAE':>10} {'>8 %':>7} | {'after MAE':>9} {'>8 %':>7} | {'fx ms':>6}")
    for r in rows:
        b, a = r['before'], r['after']
        size = f"{r['width']}x{r['height']}"
        print(f"{r['name']:26} {size:>11} | {b['mae']:10.3f} {b['over8']:7.2f} | {a['mae']:9.3f} {a['over8']:7.2f} | {r['ms']:6}")
    with open(os.path.join(OUT, 'results.json'), 'w') as f:
        json.dump(rows, f, indent=1)


if __name__ == '__main__':
    main()
