#!/usr/bin/env python3
# PSD 合成の確かめ：psd-test.html を Chrome で開き、psd-fixtures の PSD を合成して Photoshop の合成画像と比べる。
# 使い方（app で）：
#   (setsid nohup npx vite --port 5174 >/tmp/vite-a.log 2>&1 &)
#   python3 scripts/psd-check.py [名前 ...]        名前を省くと全部（psd-fixtures/<名前>/src.psd と、直下の akane.psd）
#   python3 scripts/psd-check.py --unit            表示状態の決まりと、手で作った PSD での確かめだけ
#   python3 scripts/psd-check.py --bench [名前.psd ...]  3000×4000・150 レイヤーの合成と、大きな PSD の合成時間を測る
# 合成結果と差の画像は psd-fixtures/_out/ に書く。

import base64
import os
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, '..', 'psd-fixtures')
OUT = os.path.join(FIX, '_out')
URL = os.environ.get('PSD_TEST_URL', 'http://localhost:5174/psd-test.html')

# レイヤー効果を使うもの（効果の担当の出来によって差が出る）
FX = {'effects', 'blend-mode', 'group-drop-shadows', 'gradient-overlay', 'lantern', 'text-layer', '2026-blend-modes'}


def save(name, data_url):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(base64.b64decode(data_url.split(',', 1)[1]))


def open_page(page):
    # 開発サーバーがほかのファイルの変更で読み直しを起こすことがあるので、何度か試す
    for i in range(10):
        try:
            page.goto(URL)
            page.wait_for_function('window.psdReady === true', timeout=30000)
            return
        except Exception:  # noqa: BLE001
            if i == 9:
                raise
            time.sleep(1)


def main():
    args = sys.argv[1:]
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        page = browser.new_page()
        page.on('console', lambda m: print('[console]', m.text) if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: print('[pageerror]', e))
        open_page(page)

        if args[:1] == ['--bench']:
            ts = page.evaluate('window.psdSynthBench()')
            print('synthetic 3000x4000, 150 layers: render [' + ', '.join(f'{t:.0f}' for t in ts) + '] ms')
            for name in args[1:]:
                r = page.evaluate('n => window.psdBench("/psd-fixtures/" + n, 6)', name)
                ts = ', '.join(f'{t:.0f}' for t in r['times'])
                print(f"{name}: {r['width']}x{r['height']} {r['layers']} nodes  load {r['tLoad']:.0f} ms  render [{ts}] ms")
            browser.close()
            return

        # 直下の akane.psd（本物の立ち絵）は、PSD 内の合成画像と比べる
        # 直下の fx-*.psd（効果付きの見本。同じ名前の .png が正解）も比べる
        names = [] if args == ['--unit'] else args or (['akane.psd'] if os.path.exists(os.path.join(FIX, 'akane.psd')) else []) + sorted(
            d for d in os.listdir(FIX) if os.path.isfile(os.path.join(FIX, d, 'src.psd'))) + sorted(
            f for f in os.listdir(FIX) if f.startswith('fx-') and f.endswith('.psd') and os.path.exists(os.path.join(FIX, f[:-4] + '.png')))
        print(f"{'case':32} {'vs canvas.png: R G B A':>30} {'>8 %':>7} | {'vs composite: R G B A':>30} {'>8 %':>7} | {'1st':>6} {'again':>6} ms")
        for name in names:
            r = None
            for _ in range(3):
                try:
                    r = page.evaluate('n => window.psdCheck(n)', name)
                    break
                except Exception as e:  # noqa: BLE001
                    # 開発サーバーがファイルの変更でページを読み直したときは、やり直す
                    err = str(e).splitlines()[0]
                    open_page(page)
            if r is None:
                print(f'{name:32} ERROR {err}')
                continue
            safe = name
            save(f'{safe}-render.png', r['renderPng'])
            cols = []
            for key in ('png', 'composite'):
                d = r.get(key)
                if not d:
                    cols.append(f"{'-':>30} {'-':>7}")
                elif 'error' in d:
                    cols.append(f"{d['error'][:30]:>30} {'-':>7}")
                else:
                    save(f'{safe}-diff-{key}.png', d['diffPng'])
                    mae = ' '.join(f'{v:6.2f}' for v in d['mae'])
                    cols.append(f"{mae:>30} {d['over8']:7.2f}")
            tag = ' (fx)' if name in FX or name.startswith('fx-') else ''
            print(f"{(name + tag):32} {cols[0]} | {cols[1]} | {r['tFirst']:6.0f} {r['tAgain']:6.0f}")

        if not args or args == ['--unit']:
            print('\n表示状態の決まり・手で作った PSD:')
            res = page.evaluate('window.psdUnit()') + page.evaluate('window.psdSynth()')
            if os.path.exists(os.path.join(FIX, 'tachie.psd')):
                res += page.evaluate('n => window.psdRenderUnit(n)', 'tachie.psd')
            for t in res:
                print(f"  {'OK ' if t['ok'] else 'NG '} {t['name']}" + ('' if t['ok'] else f"  {t.get('detail', '')}"))
        browser.close()


if __name__ == '__main__':
    main()
