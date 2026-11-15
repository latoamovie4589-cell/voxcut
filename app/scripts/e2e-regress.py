"""画面の回帰試験（前に壊れた操作を、実際に画面を動かして確かめる）。

使い方:
  1. `npm --prefix app run dev` で開発サーバーを起動（http://localhost:5173、音声合成は模擬動作）
  2. `python3 app/scripts/e2e-regress.py`  （Playwright と Chrome が必要。CHROME で実行ファイルを指定できる）
失敗があれば「NG」と内容を出して、終了コード 1 で終わる。
"""
import asyncio, os, sys
from playwright.async_api import async_playwright

URL = os.environ.get("VOXCUT_URL", "http://localhost:5173/")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
LINES = "async()=>{const s=(await import('/src/store.ts')).getState(); return s.project.clips.filter(c=>c.type==='voice').sort((a,b)=>a.start-b.start).map(c=>({id:c.id,text:c.text,ch:c.characterId,audio:!!c.audio,start:c.start,dur:c.duration}))}"
fails = []

def check(name, ok, detail=""):
    print(("ok  " if ok else "NG  ") + name + (f"  … {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(name)

async def fresh(b, sample=True, w=1440, h=900):
    pg = await b.new_page(viewport={"width": w, "height": h})
    pg.errs = []
    pg.on("pageerror", lambda e: pg.errs.append(str(e)))
    await pg.goto(URL)
    await pg.wait_for_timeout(1500)
    if sample:
        await pg.evaluate("async()=>{const a=await import('/src/actions.ts'); window.__mockSynthMs=80; await a.newProjectAction(a.getNotify(), true)}")
        await pg.wait_for_timeout(700)
    return pg

async def open_doc(pg):
    await pg.get_by_role("tab", name="台本").click()
    await pg.wait_for_timeout(300)
    await pg.get_by_role("radio", name="文書で書く").click()
    await pg.wait_for_timeout(300)
    return pg.locator("textarea.vx-script-doc-input")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])

        # ── 文書モード：書いてすぐタブを替えても消えない／頼んでいない行は合成しない
        pg = await fresh(b)
        ta = await open_doc(pg)
        await ta.click(); await pg.keyboard.press("Control+Home"); await pg.keyboard.press("End"); await pg.keyboard.type("XYZ")
        await pg.wait_for_timeout(200)
        await pg.get_by_role("tab", name="プロパティ").click(); await pg.wait_for_timeout(900)
        ls = await pg.evaluate(LINES)
        check("文書：書いてすぐタブを替えても残る", any("XYZ" in l["text"] for l in ls))
        check("文書：タブを替えても、ほかの未合成の行は合成しない", sum(1 for l in ls if l["audio"]) <= 1, str([(l["text"][:6], l["audio"]) for l in ls]))

        # ── 文書モード：元に戻すは 1 行ずつ
        await pg.get_by_role("tab", name="台本").click(); await pg.wait_for_timeout(300)
        ta = pg.locator("textarea.vx-script-doc-input")
        n0 = len(await pg.evaluate(LINES))
        await ta.click(); await pg.keyboard.press("Control+End")
        await pg.keyboard.press("Enter"); await pg.keyboard.type("一行目"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(300)
        await pg.keyboard.type("二行目"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(400)
        n1 = len(await pg.evaluate(LINES))
        await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(400)
        n2 = len(await pg.evaluate(LINES))
        check("文書：2 行足して Ctrl+Z で 1 行だけ戻る", (n1, n2) == (n0 + 2, n0 + 1), f"{n0},{n1},{n2}")

        # ── 文書モード：知らない名前 →（欄にカーソルがあるまま）キャラクターを作る → 行が入る・知らせは 1 枚・元に戻すは 1 回
        pg = await fresh(b)
        ta = await open_doc(pg)
        await ta.click(); await pg.keyboard.press("Control+End"); await pg.keyboard.press("Enter")
        await pg.keyboard.type("ずんだもん：知らない人の行"); await pg.wait_for_timeout(1900)
        check("文書：知らない名前の知らせが出る", await pg.get_by_text("というキャラクターがいません").count() == 1)
        chars0 = await pg.evaluate("async()=>(await import('/src/store.ts')).getState().project.characters.length")
        await pg.get_by_role("button", name="キャラクターを作る").click(); await pg.wait_for_timeout(700)
        ls = await pg.evaluate(LINES)
        names = await pg.evaluate("async()=>(await import('/src/store.ts')).getState().project.characters.map(c=>c.name)")
        check("文書：作ったキャラクターの行がタイムラインに入る", any(l["text"] == "知らない人の行" for l in ls) and "ずんだもん" in names, str(names))
        check("文書：作ったあとも欄に行が残る", "知らない人の行" in await ta.input_value())
        # 知らせ 1 枚は、見える文と読み上げ用の文の 2 か所に出る
        check("文書：「作りました」の知らせは 1 枚", await pg.get_by_text("人作りました").count() == 2)

        # ── 文書モードの中から Ctrl+H：置き換えの欄が開いて、すぐ打てる
        await ta.click(); await pg.keyboard.press("Control+h"); await pg.wait_for_timeout(500)
        check("文書：Ctrl+H で探す欄にカーソル", await pg.evaluate("document.activeElement.closest('[data-script-search]')!==null"))

        # ── 下の入力欄：Ctrl+Z・知らない名前・Esc
        pg = await fresh(b)
        inp = pg.get_by_role("textbox", name="新しいセリフ")
        n0 = len(await pg.evaluate(LINES))
        await inp.click(); await inp.type("足した行"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(400)
        n1 = len(await pg.evaluate(LINES))
        await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(300)
        n2 = len(await pg.evaluate(LINES))
        check("入力欄：入れた直後の Ctrl+Z で戻る", (n1, n2) == (n0 + 1, n0), f"{n0},{n1},{n2}")
        await inp.type("めたん：はじめまして"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(300)
        check("入力欄：知らない名前は一度止めて聞く", len(await pg.evaluate(LINES)) == n0 and await pg.get_by_role("button", name="「めたん」を作って入れる").count() == 1)
        await pg.get_by_role("button", name="「めたん」を作って入れる").click(); await pg.wait_for_timeout(500)
        ls = await pg.evaluate(LINES)
        names = await pg.evaluate("async()=>(await import('/src/store.ts')).getState().project.characters.map(c=>c.name)")
        check("入力欄：作って入れると、その人のセリフとして入る", "めたん" in names and any(l["text"] == "はじめまして" for l in ls), str(names))
        await inp.click(); await pg.keyboard.press("Escape"); await pg.wait_for_timeout(100)
        check("入力欄：Esc で欄から出る", await pg.evaluate("document.activeElement.tagName") != "INPUT")

        # ── 再生位置がほかの人のセリフの途中でも、割り込まない
        pg = await fresh(b)
        await pg.evaluate("async()=>{const a=await import('/src/actions.ts'); await a.synthesize(a.getNotify())}"); await pg.wait_for_timeout(900)
        await pg.evaluate("async()=>{(await import('/src/store.ts')).setState({playhead: 60})}")
        inp = pg.get_by_role("textbox", name="新しいセリフ")
        await inp.click(); await inp.type("途中に入れた行"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(700)
        ov = await pg.evaluate("async()=>{const m=await import('/src/model.ts'); const s=(await import('/src/store.ts')).getState(); return [...m.overlappingLines(s.project)].length}")
        check("追記：ほかのセリフと重ならない", ov == 0, str(ov))

        # ── 再生中の追従スクロール、ホイールで戻したら引き戻さない
        await pg.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({zoom:10, playhead:0}); document.querySelector('.vx-timeline-scroll').scrollLeft=0}")
        await pg.wait_for_timeout(300)
        await pg.evaluate("async()=>{(await import('/src/preview/playback.ts')).play()}")
        await pg.wait_for_timeout(4500)
        sl = await pg.evaluate("document.querySelector('.vx-timeline-scroll').scrollLeft")
        check("再生：タイムラインが再生位置を追いかける", sl > 300, str(sl))
        box = await pg.locator(".vx-timeline-scroll").bounding_box()
        await pg.mouse.move(box["x"] + 300, box["y"] + 60)
        await pg.mouse.wheel(-600, 0); await pg.wait_for_timeout(900)
        sl2 = await pg.evaluate("document.querySelector('.vx-timeline-scroll').scrollLeft")
        check("再生：ホイールで戻したら 2 秒は引き戻さない", sl2 < sl - 200, f"{sl}->{sl2}")
        await pg.evaluate("async()=>{(await import('/src/preview/playback.ts')).stop()}")

        # ── メニューを閉じるとき跳ねない（閉じている途中に動きが走らない）
        pg = await fresh(b)
        await pg.get_by_role("button", name="表示").first.click(); await pg.wait_for_timeout(300)
        await pg.keyboard.press("Escape"); await pg.wait_for_timeout(30)
        tr = await pg.evaluate("[...document.querySelectorAll('[data-astryx-layer-root] .astryx-popover')].map(e=>getComputedStyle(e).transform)")
        check("メニュー：閉じるとき縮んで跳ねない", all(t in ("none", "matrix(1, 0, 0, 1, 0, 0)") for t in tr), str(tr))

        # ── ダークで、選ばれている切り替えが溝よりはっきり明るい
        await pg.get_by_role("tab", name="台本").click(); await pg.wait_for_timeout(300)
        c = await pg.evaluate("""(()=>{const lum=c=>{const m=c.match(/[\\d.]+/g).map(Number);const f=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4};return .2126*f(m[0])+.7152*f(m[1])+.0722*f(m[2])};
          const sel=document.querySelector(".astryx-segmented-control-item[data-selected='selected']"); const tr=sel.closest('.astryx-segmented-control');
          const a=lum(getComputedStyle(sel).backgroundColor), b=lum(getComputedStyle(tr).backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)})()""")
        check("切り替え：選ばれている側が見分けられる（明るさの比 2 以上）", c >= 2, f"{c:.2f}")

        # ── 最初の 3 手順カードが切れない（低い・狭い画面）
        for (w, h) in [(1280, 720), (1024, 700)]:
            q = await fresh(b, sample=False, w=w, h=h)
            r = await q.evaluate("(()=>{const e=document.querySelector('.vx-start'); const host=e.parentElement.getBoundingClientRect(), r=e.getBoundingClientRect(); return [e.scrollHeight<=e.clientHeight+1, r.bottom<=host.bottom+1, r.left>=host.left+220]})()")
            check(f"3 手順カード：{w}×{h} で切れず、レイヤー名にかぶらない", all(r), str(r))
            await q.close()

        # ── 最初のキャラクターは使える声で作られ、最初のセリフが失敗しない
        pg = await fresh(b, sample=False)
        await pg.get_by_role("button", name="キャラクターを作る…").click(); await pg.wait_for_timeout(600)
        await pg.keyboard.press("Escape"); await pg.wait_for_timeout(400)
        inp = pg.get_by_role("textbox", name="新しいセリフ")
        await inp.click(); await inp.type("最初のセリフ"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(900)
        errs = await pg.evaluate("async()=>Object.keys((await import('/src/store.ts')).getState().synthErrors).length")
        ls = await pg.evaluate(LINES)
        check("最初のセリフが合成できる", errs == 0 and len(ls) == 1 and ls[0]["audio"], f"errs={errs} {ls}")

        # ── fps を変えると、置いてあるアイテムが同じ時間になるよう数え直され、元に戻すで戻る
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const L=()=>s.getState().project.clips.map(c=>[c.start,c.duration]); const a=L(); s.updateVideo({fps:60}); const b=L(); s.undo(); const c=L();
          return [b.every((x,i)=>x[0]===a[i][0]*2 && x[1]===a[i][1]*2), JSON.stringify(a)===JSON.stringify(c)]}""")
        check("fps：30→60 で位置と長さが 2 倍になり、元に戻すで戻る", all(r), str(r))
        await q.close()

        check("画面のエラーが出ていない", not pg.errs, str(pg.errs[:3]))
        await b.close()
    print(f"\n{'すべて通りました' if not fails else str(len(fails)) + ' 件 NG'}")
    sys.exit(1 if fails else 0)

asyncio.run(main())
