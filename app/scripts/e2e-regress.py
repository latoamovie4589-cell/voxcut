"""画面の回帰試験（前に壊れた操作を、実際に画面を動かして確かめる）。

使い方:
  1. `npm --prefix app run dev` で開発サーバーを起動（http://localhost:5173、音声合成は模擬動作）
  2. `python3 app/scripts/e2e-regress.py`  （Playwright と Chrome が必要。CHROME で実行ファイルを指定できる）
失敗があれば「NG」と内容を出して、終了コード 1 で終わる。
"""
import asyncio, re, os, sys
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
        # 1 回目のホイールが追いかけのなめらかなスクロールと重なることがあるので、少し間を空けて 2 回に分ける
        sl = await pg.evaluate("document.querySelector('.vx-timeline-scroll').scrollLeft")
        await pg.mouse.wheel(-400, 0); await pg.wait_for_timeout(150)
        await pg.mouse.wheel(-400, 0); await pg.wait_for_timeout(900)
        sl2 = await pg.evaluate("document.querySelector('.vx-timeline-scroll').scrollLeft")
        if sl2 >= sl - 40:
            # 負荷が高いとホイールが追いかけのスクロールに飲まれることがあるので、もう 1 回だけ
            sl = sl2
            await pg.mouse.wheel(-400, 0); await pg.wait_for_timeout(900)
            sl2 = await pg.evaluate("document.querySelector('.vx-timeline-scroll').scrollLeft")
        await pg.wait_for_timeout(700)
        sl3 = await pg.evaluate("document.querySelector('.vx-timeline-scroll').scrollLeft")
        # 戻した位置から、追いかけで前へ引き戻されていない（再生は続いている）
        check("再生：ホイールで戻したら 2 秒は引き戻さない", sl2 < sl - 40 and sl3 <= sl2 + 2, f"{sl}->{sl2}->{sl3}")
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


        # ── マーカー：M で付く・概要欄のチャプターになる・fps を変えると同じ時間に付いていく
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const d=await import('/src/panels/DescriptionDialog.tsx');
          s.setState({playhead:0}); s.addMarker(); s.setState({playhead:450}); const id=s.addMarker(); s.updateMarker(id,{name:'本題'}); s.setState({playhead:2250}); s.addMarker(); s.addMarker();
          const lines=d.chapterLines(s.getState().project); s.updateVideo({fps:60}); const f=s.getState().project.markers.map(m=>m.frame); s.undo();
          return [s.getState().project.markers.length===3, lines[1]==='0:15 本題' && lines[2].startsWith('1:15 '), JSON.stringify(f)==='[0,900,4500]']}""")
        check("マーカー：同じ位置は 1 つ・チャプターの行・fps に付いていく", all(r), str(r))
        await q.keyboard.press("Escape")
        await q.evaluate("document.activeElement?.blur()")
        n0 = await q.evaluate("async()=>(await import('/src/store.ts')).getState().project.markers.length")
        await q.evaluate("async()=>(await import('/src/store.ts')).setState({playhead:777})")
        await q.keyboard.press("m"); await q.wait_for_timeout(300)
        n1 = await q.evaluate("async()=>(await import('/src/store.ts')).getState().project.markers.length")
        check("マーカー：M キーで再生位置に付く", n1 == n0 + 1, f"{n0}->{n1}")
        await q.get_by_role("button", name="名前を付ける").first.click(); await q.wait_for_timeout(500)
        check("マーカー：知らせから「マーカーと概要欄」が開き、貼る文章が出る", await q.locator("dialog[open] .vx-description").count() == 1)
        check("マーカーの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── 動き：途中の状態を通る・登場は画面の外から・退場で小さくなる（書き出しの式と同じ値）
        q = await fresh(b, sample=False)
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts'); const t={x:0,y:0,scale:1,opacity:1};
          const look={rotation:0,fadeIn:0,fadeOut:0,effects:[],anim:{to:{x:100,y:0,scale:1,opacity:1},rotation:0,ease:'linear',mid:{at:0.5,transform:{x:-50,y:40,scale:1.5,opacity:1},rotation:0}}};
          const a=v.visualAt(t,look,15,60,30,0,[320,180]).transform, m=v.visualAt(t,look,30,60,30,0,[320,180]).transform, e=v.visualAt(t,look,60,60,30,0,[320,180]).transform;
          const l2={rotation:0,fadeIn:0,fadeOut:0,effects:[],enter:{kind:'slideLeft',frames:10},exit:{kind:'zoom',frames:10}};
          const s0=v.visualAt(t,l2,0,60,30,0,[320,180]).transform, s5=v.visualAt(t,l2,5,60,30,0,[320,180]).transform, s30=v.visualAt(t,l2,30,60,30,0,[320,180]).transform, s55=v.visualAt(t,l2,55,60,30,0,[320,180]).transform;
          const near=(x,y)=>Math.abs(x-y)<1e-6;
          return [near(a.x,-25)&&near(a.y,20)&&near(a.scale,1.25), near(m.x,-50)&&near(m.scale,1.5), near(e.x,100)&&near(e.y,0), near(s0.x,-320), near(s5.x,-80), near(s30.x,0)&&near(s30.scale,1), near(s55.scale,0.75)]}""")
        check("動き：途中の状態・登場・退場の計算", all(r), str(r))
        await q.close()

        # ── 入力欄から足すと、止まっている音声合成ソフトを起動してから合成する（YMM4 と同じ）
        q = await b.new_page(viewport={"width": 1440, "height": 900})
        q.errs = []
        q.on("pageerror", lambda e: q.errs.append(str(e)))
        await q.add_init_script("""window.__launched=[]; window.__mockSynthMs=80;
          window.__mockEngines=()=>['aivoice','voicepeak','voisona','voicevox'].map(e=>({engine:e,status:window.__launched.includes(e)?{state:'ready',version:'1'}:{state:'notRunning',detail:'起動していません'}}));
          window.__mockLaunch=e=>{ if(e==='voisona') return false; setTimeout(()=>window.__launched.push(e),1200); return true }""")
        await q.goto(URL); await q.wait_for_timeout(1500)
        await q.evaluate("async()=>{const a=await import('/src/actions.ts'); await a.newProjectAction(a.getNotify(), true)}")
        await q.wait_for_timeout(600)
        inp = q.get_by_role("textbox", name="新しいセリフ")
        await inp.click(); await inp.type("自動で起動して合成"); await q.keyboard.press("Enter"); await q.wait_for_timeout(600)
        mid = await q.evaluate("()=>document.body.innerText.includes('を起動しています')")
        await q.wait_for_timeout(4500)
        ls = [l for l in await q.evaluate(LINES) if l["text"] == "自動で起動して合成"]
        st = await q.evaluate("async()=>{const s=(await import('/src/store.ts')).getState(); return [window.__launched.length, Object.keys(s.synthErrors).length]}")
        check("自動起動：起動中の知らせが出て、起動後に合成される", mid and len(ls) == 1 and ls[0]["audio"] and st[0] == 1 and st[1] == 0, f"mid={mid} {ls} {st}")
        check("自動起動の画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── 素材のつなぎ直し：見つからない素材を調べ、場所を選ぶと同じフォルダのほかの素材もつながる
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const a=await import('/src/actions.ts');
          s.addMediaClips([{path:'/old/a.png',info:{kind:'image',hasAudio:false,durationMs:null,width:10,height:10}},{path:'/old/b.png',info:{kind:'image',hasAudio:false,durationMs:null,width:10,height:10}}]);
          window.__mockMissing=['/old/a.png','/old/b.png']; const m=await a.checkMedia(); window.__mockRelink='/new/a.png'; const n=await a.relinkMedia('/old/a.png');
          const srcs=s.getState().project.clips.filter(c=>c.type==='media').map(c=>c.src).filter(x=>x.endsWith('.png')&&x.length<12).sort();
          return [m.length===2, n===2, JSON.stringify(srcs)==='["/new/a.png","/new/b.png"]', s.getState().missingMedia.length===0]}""")
        check("素材：見つからない素材を調べて、まとめてつなぎ直せる", all(r), str(r))

        # ── テンプレート：アイテムを取っておいて、再生位置に置ける
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const t=await import('/src/templates.ts'); localStorage.removeItem('voxcut.templates');
          const id=s.addVisualItem('text'); s.updateClip(id,{text:'見出し',color:'#FF0000'}); const c=s.getState().project.clips.find(x=>x.id===id);
          const tp=t.saveTemplate('item', t.itemTemplateName(c), c); const tp2=t.saveTemplate('item','見出し',c); s.setState({playhead:3000}); const nid=s.insertItemTemplate(tp.data);
          const n=s.getState().project.clips.find(x=>x.id===nid);
          return [tp.name==='見出し', tp2.name==='見出し 2', n.start===3000 && n.text==='見出し' && n.color==='#FF0000' && n.id!==id, JSON.parse(localStorage.getItem('voxcut.templates')).length===2]}""")
        check("テンプレート：保存・名前の重なり・再生位置に置く", all(r), str(r))
        for (menu, item, title) in [("ツール", "テンプレート…", "テンプレート"), ("ファイル", "素材の場所と整理…", "素材の場所と整理")]:
            await q.get_by_role("button", name=menu, exact=True).click(); await q.wait_for_timeout(250)
            await q.get_by_role("menuitem", name=item).click(); await q.wait_for_timeout(500)
            check(f"メニュー「{item}」で画面が開く", await q.locator("dialog[open]").get_by_text(title, exact=True).count() >= 1)
            await q.keyboard.press("Escape"); await q.wait_for_timeout(350)
        await q.get_by_role("button", name="ファイル", exact=True).click(); await q.wait_for_timeout(250)
        await q.get_by_role("menuitem", name="この場面を画像で書き出す…").click(); await q.wait_for_timeout(1500)
        check("画像の書き出し：終わると知らせが出る", await q.evaluate("()=>document.body.innerText.includes('画像を書き出しました')"))
        check("素材・テンプレートの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()


        # ── かんたんエフェクト：押すだけで付く・もう一度押すと外れる・画面効果は重ねられる
        q = await fresh(b)
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({playhead:60}); s.addVisualItem('text')}")
        await q.wait_for_timeout(500)
        LOOK = "async()=>{const s=(await import('/src/store.ts')).getState(); const c=s.project.clips.find(x=>x.id===s.selectedClipId); return {look:c.look||null, x:c.transform.x, playing:s.isPlaying}}"
        await q.get_by_role("button", name="エフェクト", exact=True).click(); await q.wait_for_timeout(900)
        vis = await q.evaluate("()=>{const r=document.querySelector('.vx-fx-grid').getBoundingClientRect(); return r.top>=0 && r.top<innerHeight-60 && document.activeElement?.classList.contains('vx-fx-tile')}")
        check("かんたんエフェクト：タイムラインの「エフェクト」で一覧が見える位置に出る", vis)
        await q.locator(".vx-fx-tile[data-fx='in-left']").click(); await q.wait_for_timeout(250)
        r1 = await q.evaluate(LOOK)
        await q.wait_for_timeout(1800)
        r1b = await q.evaluate(LOOK)
        check("かんたんエフェクト：登場「左から」が付き、その部分を再生して止まる", r1["look"]["enter"]["kind"] == "slideLeft" and r1["playing"] and not r1b["playing"] and await q.locator(".vx-fx-tile[data-fx='in-left'][aria-pressed='true']").count() == 1, str(r1))
        await q.locator(".vx-fx-tile[data-fx='in-left']").click(); await q.wait_for_timeout(250)
        r2 = await q.evaluate(LOOK)
        check("かんたんエフェクト：もう一度押すと外れる", not r2["look"].get("enter") and await q.locator(".vx-fx-tile[data-fx='in-none'][aria-pressed='true']").count() == 1, str(r2))
        await q.get_by_role("radio", name="動き").click(); await q.wait_for_timeout(200)
        await q.locator(".vx-fx-tile[data-fx='mv-bounce']").click(); await q.wait_for_timeout(250)
        r3 = await q.evaluate(LOOK)
        check("かんたんエフェクト：動き「はずむ」は今の位置から作る", r3["look"]["anim"]["mid"]["transform"]["y"] == -70 and r3["look"]["anim"]["to"]["x"] == r3["x"], str(r3))
        await q.evaluate("async()=>{(await import('/src/preview/playback.ts')).stop()}")
        await q.get_by_role("radio", name="画面効果").click(); await q.wait_for_timeout(200)
        for k in ["fx-mono", "fx-blur", "fx-vivid", "fx-dark"]:
            await q.locator(f".vx-fx-tile[data-fx='{k}']").click(); await q.wait_for_timeout(200)
        r4 = await q.evaluate(LOOK)
        kinds = [e["kind"] for e in r4["look"]["effects"]]
        check("かんたんエフェクト：画面効果は重なり、同じ種類は入れ替わる", kinds == ["mono", "blur", "color"] and r4["look"]["effects"][2]["brightness"] == 0.6, str(kinds))
        await q.evaluate("async()=>{(await import('/src/preview/playback.ts')).stop()}")
        check("かんたんエフェクトの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()


        # ── 切り替え：同じレイヤーで接している次のアイテムに付ける。書き出しと同じ置き換え（Rust の with_transitions と同じ値）
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const m=await import('/src/model.ts');
          s.setState({playhead:3000}); const a=s.addVisualItem('text'); const ca=s.getState().project.clips.find(c=>c.id===a);
          s.setState({playhead:ca.start+ca.duration}); const b=s.addVisualItem('text'); const cb=s.getState().project.clips.find(c=>c.id===b);
          return {a, b, same: ca.trackId===cb.trackId, adj: m.prevAdjacent(s.getState().project, cb)?.id===a}}""")
        check("切り替え：2 つ目のテキストが同じレイヤーで前と接する", r["same"] and r["adj"], str(r))
        A, B = r["a"], r["b"]
        await q.wait_for_timeout(300)
        await q.evaluate(f"async()=>{{const s=await import('/src/store.ts'); s.setState({{selectedClipId:'{B}', selectedClipIds:['{B}'], fxTab:'trans'}})}}")
        await q.wait_for_timeout(400)
        await q.locator(".vx-fx-tile[data-fx='tr-left']").click(); await q.wait_for_timeout(300)
        r = await q.evaluate(f"""async()=>{{const s=await import('/src/store.ts'); const m=await import('/src/model.ts'); const p=s.getState().project;
          const t=p.clips.find(c=>c.id==='{B}').look.transition; const d=m.withTransitions(p); const ga=d.clips.find(c=>c.id==='{A}'), gb=d.clips.find(c=>c.id==='{B}');
          return {{t, ex: ga.look.exit, en: gb.look.enter, pressed: !!document.querySelector(".vx-fx-tile[data-fx='tr-left'][aria-pressed='true']")}}}}""")
        check("切り替え：「左へ流す」で前は左へ出て、次は右から入る（同じ長さで同時に）", r["t"]["kind"] == "slideLeft" and r["ex"]["kind"] == "slideLeft" and r["en"]["kind"] == "slideRight" and r["ex"]["frames"] == r["en"]["frames"] == r["t"]["frames"] and r["ex"].get("smooth") and r["pressed"], str(r))
        r = await q.evaluate(f"""async()=>{{const s=await import('/src/store.ts'); const m=await import('/src/model.ts'); const v=await import('/src/preview/visual.ts'); const p=s.getState().project;
          const d=m.withTransitions(p); const ga=d.clips.find(c=>c.id==='{A}'), gb=d.clips.find(c=>c.id==='{B}'); const fps=p.video.fps, W=p.video.width; const out=[];
          for (const k of [0.25,0.5,0.75]) {{ const t=gb.start+Math.round(gb.look.enter.frames*k);
            const xa=v.visualAt(ga.transform, ga.look, t-ga.start, ga.duration, fps, t/fps, [W,p.video.height]).transform.x;
            const xb=v.visualAt(gb.transform, gb.look, t-gb.start, gb.duration, fps, t/fps, [W,p.video.height]).transform.x;
            out.push(Math.abs((xb-gb.transform.x)-(xa-ga.transform.x)-W)<1e-6 && xa<ga.transform.x && xb>gb.transform.x) }}
          return out}}""")
        check("切り替え：押し出しの途中も、前と次の場面がくっついたまま動く", all(r), str(r))
        await q.evaluate("async()=>{(await import('/src/preview/playback.ts')).stop()}")
        r = await q.evaluate(f"""async()=>{{const s=await import('/src/store.ts'); const m=await import('/src/model.ts'); const v=await import('/src/preview/visual.ts');
          const lk=k=>{{const p=s.getState().project; const c=p.clips.find(c=>c.id==='{B}'); s.updateClip('{B}',{{look:{{...c.look, transition:{{kind:k, frames:20}}}}}}); return m.withTransitions(s.getState().project)}};
          const p0=s.getState().project; const a0=p0.clips.find(c=>c.id==='{A}');
          const d1=lk('dissolve'); const ga=d1.clips.find(c=>c.id==='{A}');
          const d2=lk('black'); const ids=d2.clips.slice(-2).map(c=>c.id); const imgs=await v.bakeItemImages(d2);
          return {{ext: ga.duration===a0.duration+20 && ga.look.fadeOut===20 && d1.clips.find(c=>c.id==='{B}').look.fadeIn===20,
            covers: JSON.stringify(ids)===JSON.stringify(['{B}~cover1','{B}~cover2']), baked: !!imgs['{B}~cover1'] && !!imgs['{B}~cover2'], same: s.getState().project.clips.length===p0.clips.length}}}}""")
        check("切り替え：クロスフェードは前を延ばし、暗転は覆う図形を最後に足す（元のプロジェクトは変えない）", all(r.values()), str(r))
        r = await q.evaluate("""async()=>{const m=await import('/src/model.ts'); const s=await import('/src/store.ts'); const p0=s.getState().project;
          const base={trackId:'V1', linkId:null, type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}};
          const va={...base, id:'va', start:0, duration:60, src:'/m/a.mp4', mediaKind:'video', hasAudio:true};
          const vb={...base, id:'vb', start:60, duration:60, src:'/m/b.png', mediaKind:'image', hasAudio:false, look:{rotation:0, fadeIn:0, fadeOut:0, transition:{kind:'slideLeft', frames:20}}};
          const p={...p0, clips:[va, vb]}; const d=m.withTransitions(p); const ga=d.clips.find(c=>c.id==='va');
          const vb2={...vb, look:{...vb.look, transition:{kind:'dissolve', frames:20}}}; const g2=m.withTransitions({...p, clips:[va, vb2]}).clips.find(c=>c.id==='va');
          return {push: ga.duration===80 && ga.audioUntil===60 && ga.look.exit?.smooth===true, dis: g2.duration===80 && g2.audioUntil===60 && g2.look.fadeOut===20, orig: va.audioUntil===undefined && va.duration===60}}""")
        check("切り替え：前が動画でも映像だけ延ばして押し出し・ディゾルブし、音は元の長さで止める", all(r.values()), str(r))
        await q.evaluate(f"async()=>{{const s=await import('/src/store.ts'); s.setState({{selectedClipId:'{A}', selectedClipIds:['{A}']}})}}")
        await q.wait_for_timeout(300)
        dis = await q.evaluate("()=>document.querySelector(\".vx-fx-tile[data-fx='tr-left']\")?.disabled")
        check("切り替え：前に接するアイテムがないと選べない", dis is True, str(dis))
        await q.evaluate(f"async()=>{{const s=await import('/src/store.ts'); s.setState({{playhead:s.getState().project.clips.find(c=>c.id==='{B}').start}})}}")
        await q.wait_for_timeout(300)
        await q.get_by_role("button", name="ファイル", exact=True).click(); await q.wait_for_timeout(250)
        await q.get_by_role("menuitem", name="この場面を画像で書き出す…").click(); await q.wait_for_timeout(1500)
        check("切り替え：入れたまま画像を書き出せる", await q.evaluate("()=>document.body.innerText.includes('画像を書き出しました')"))
        check("切り替えの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── 文字の飾り：ツールバーの「テキスト」からひな形を選んで置ける。見本を押すと飾りが入れ替わる
        q = await fresh(b)
        await q.get_by_role("button", name="テキスト", exact=True).click(); await q.wait_for_timeout(250)
        await q.get_by_role("menuitem", name="ネオン").click(); await q.wait_for_timeout(500)
        CUR = "async()=>{const s=(await import('/src/store.ts')).getState(); return s.project.clips.find(x=>x.id===s.selectedClipId)}"
        c1 = await q.evaluate(CUR)
        check("文字の飾り：「テキスト ▸ ネオン」で光る文字が置かれる", c1["type"] == "text" and c1["shadowColor"] == "#00E5FF" and c1["shadowBlur"] == 14, str({k: c1.get(k) for k in ["type", "shadowColor"]}))
        check("文字の飾り：今のひな形が押された状態で出る", await q.locator(".vx-fx-tile[data-style='neon'][aria-pressed='true']").count() == 1)
        await q.locator(".vx-fx-tile[data-style='band']").click(); await q.wait_for_timeout(300)
        c2 = await q.evaluate(CUR)
        check("文字の飾り：「黒い帯」に替えると影が消えて帯が付く（文字と位置はそのまま）", c2["boxColor"] == "#000000" and c2["shadowColor"] == "" and c2["text"] == c1["text"] and c2["transform"] == c1["transform"], str({k: c2.get(k) for k in ["boxColor", "shadowColor"]}))
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts'); const base={id:'x',trackId:'',start:0,duration:1,type:'text',text:'あ',fontFamily:'Yu Gothic UI',fontSize:60,color:'#fff',outlineColor:'#000',outlineWidth:0,bold:true,italic:false,align:'center',transform:{x:0,y:0,scale:1,opacity:1}};
          const a=v.textImage(base), g=v.textImage({...base, shadowColor:'#0ff', shadowBlur:10}), o=v.textImage({...base, outline2Color:'#fff', outline2Width:8});
          return [g.width-a.width===40 && g.height-a.height===40, o.width-a.width===16, JSON.stringify(v.textKey(base))!==JSON.stringify(v.textKey({...base, gradientColor:'#f00'}))]}""")
        check("文字の飾り：光は四方に余白、外側の縁は太さの分だけ大きく、飾りが違えば別の画像", all(r), str(r))
        check("文字の飾りの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()


        # ── 声を聞く：今の声で短い文を合成して鳴らす（プロジェクトには何も足さない）
        q = await fresh(b)
        n0 = await q.evaluate("async()=>(await import('/src/store.ts')).getState().project.clips.length")
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); const p=s.getState().project; s.setState({characterDialogOpen:true, selectedCharacterId:p.characters[0].id})}")
        await q.wait_for_timeout(500)
        if await q.get_by_role("tab", name="声", exact=True).count():
            await q.get_by_role("tab", name="声", exact=True).click(); await q.wait_for_timeout(300)
        await q.get_by_role("textbox", name="試しに読ませる文").fill("テストの文です")
        await q.get_by_role("button", name="声を聞く").click(); await q.wait_for_timeout(900)
        r = await q.evaluate("async()=>[window.__lastAudition, (await import('/src/store.ts')).getState().project.clips.length, (await import('/src/store.ts')).getState().dirty]")
        check("声を聞く：書いた文で合成し、プロジェクトは変えない", r[0] == "テストの文です" and r[1] == n0, str(r))
        await q.keyboard.press("Escape"); await q.wait_for_timeout(400)

        # ── 範囲を指定して書き出す：始まりと終わりを時刻で入れると、その範囲だけを渡す
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({selectedClipId:null, selectedClipIds:[]})}")
        await q.get_by_role("button", name="動画を書き出す…").click(); await q.wait_for_timeout(600)
        await q.get_by_role("radio", name="時刻で指定").click(); await q.wait_for_timeout(200)
        await q.get_by_role("textbox", name="始まり").fill("00:00:01:00")
        await q.get_by_role("textbox", name="終わり").fill("2:15")
        await q.wait_for_timeout(200)
        fps = await q.evaluate("async()=>(await import('/src/store.ts')).getState().project.video.fps")
        await q.get_by_role("button", name="保存先を選んで書き出す…").click(); await q.wait_for_timeout(2500)
        ex = await q.evaluate("()=>window.__lastExport")
        check("範囲の書き出し：時刻で入れた範囲（短い書き方も読む）だけを渡す", ex and ex.get("rangeFrames") == [fps, 2 * fps + 15], str(ex and ex.get("rangeFrames")))
        await q.keyboard.press("Escape"); await q.wait_for_timeout(400)
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); const p=s.getState().project; const v=p.clips.find(c=>c.type==='voice'); s.setState({selectedClipId:v.id, selectedClipIds:[v.id]})}")
        await q.get_by_role("button", name="動画を書き出す…").click(); await q.wait_for_timeout(600)
        await q.get_by_role("radio", name="選んだアイテム").click(); await q.wait_for_timeout(200)
        await q.get_by_role("textbox", name="始まり").count()
        await q.get_by_role("button", name="保存先を選んで書き出す…").click(); await q.wait_for_timeout(2500)
        r = await q.evaluate("async()=>{const p=(await import('/src/store.ts')).getState().project; const v=p.clips.find(c=>c.type==='voice'); return [window.__lastExport.rangeFrames, [v.start, v.start+v.duration]]}")
        check("範囲の書き出し：選んだアイテムの範囲だけを渡す", r[0] == r[1], str(r))
        await q.keyboard.press("Escape"); await q.wait_for_timeout(400)

        # ── 字幕の影と帯：キャラクターの字幕に付けられて、プレビューでも描ける
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const m=await import('/src/model.ts'); const p=s.getState().project; const ch=p.characters[0];
          s.updateCharacter(ch.id,{subtitle:{...ch.subtitle, shadowColor:'#000000', shadowOffset:5, boxColor:'#202020', boxOpacity:0.6, boxPadding:14}});
          const v=p.clips.find(c=>c.type==='voice' && c.characterId===ch.id); s.setState({playhead:v.start+2});
          await new Promise(r=>setTimeout(r,300)); return [m.timecodeToFrames('00:00:08:06',30)===246, m.timecodeToFrames('8:40',30)===null, m.timecodeToFrames('x',30)===null]}""")
        check("時刻の読み取り：時:分:秒:フレーム と、読めないものを見分ける", all(r), str(r))
        check("声・範囲・字幕の飾りの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()


        # ── 字幕の改行：書き出し（Rust の wrap_subtitle）と同じ位置で切る
        q = await fresh(b, sample=False)
        r = await q.evaluate("""async()=>{const w=(await import('/src/subtitleWrap.ts')).wrapSubtitle;
          return [w('あいうえおかきくけこ',10,50), w('あいうえお。かきくけこ',10,50), w('あいう「えおか」き',10,40), w('これはVOICEVOXです',10,60), w('あいうえおかきく',56,1840,3), w('短い\\n改行',56,1840)]}""")
        check("字幕の改行：幅・句読点・括弧・英単語の扱いが書き出しと同じ", r == ["あいうえお\nかきくけこ", "あいうえお。\nかきくけこ", "あいう\n「えおか」\nき", "これは\nVOICEVOXで\nす", "あいう\nえおか\nきく", "短い\n改行"], str(r))
        await q.close()

        # ── ルビ：書き方の読み取りと改行が書き出し（Rust）と同じ／ボタンで入れられる／プレビューと画像に出る
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const R=await import('/src/ruby.ts'); const segs=R.parseRuby('今日は夕暮《ゆうぐれ》時｜VoxCut《ボックスカット》です');
          const s2=R.parseRuby('ああ漢字《かんじ》いい'); const s3=R.parseRuby('漢字《かんじ》いい\\n\\nう');
          return [segs.map(s=>[s.base, s.ruby??null]), R.rubyBase('明日《あした》、｜Ｃ《シー》'), R.rubyReading('明日《あした》は晴れ'), R.rubyBase('《注》と|と《あ'), R.rubyBase('ひらがな《かな》'),
            R.keepRubyWords(s2,'ああ漢\\n字いい'), R.keepRubyWords(s3,'漢\\n字いい\\n\\nう'), R.rubyRows(s2,'ああ漢\\n字いい').map(r=>r.map(p=>[p.text,p.ruby??null,p.at]))]}""")
        check("ルビ：書き方の読み取り・外した文・読み・改行の扱いが書き出しと同じ", r == [[["今日は", None], ["夕暮", "ゆうぐれ"], ["時", None], ["VoxCut", "ボックスカット"], ["です", None]], "明日、Ｃ", "あしたは晴れ", "《注》と|と《あ", "ひらがな《かな》",
            "ああ\n漢字いい", "漢字\nいい\n\nう", [[["ああ", None, 0], ["漢", "かんじ", 2]], [["字", None, 3], ["いい", None, 4]]]], str(r))
        v = await q.evaluate("async()=>{const s=await import('/src/store.ts'); const v=s.getState().project.clips.find(c=>c.type==='voice'); s.updateClip(v.id,{text:'今日は晴れ', subtitle:null}); s.setState({selectedClipId:v.id, selectedClipIds:[v.id], playhead:v.start+5}); return v.id}")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        ta = q.get_by_label("セリフ", exact=True)
        await ta.evaluate("t=>{t.focus(); t.setSelectionRange(0,2)}")
        await q.get_by_role("button", name="ルビを付ける").first.click(); await q.wait_for_timeout(300)
        await q.keyboard.type("きょう"); await q.wait_for_timeout(200)
        r = await q.evaluate(f"async()=>{{const s=await import('/src/store.ts'); const v=s.getState().project.clips.find(c=>c.id==='{v}'); return [v.subtitle, document.activeElement?.value]}}")
        check("ルビ：ボタンで選んだ文字に《》を付け、読みをそのまま打てる", r[0] == "今日《きょう》は晴れ" and r[1] == r[0], str(r))
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts'); const t={id:'t',trackId:'V1',start:0,duration:30,linkId:null,type:'text',text:'夕暮《ゆうぐれ》',fontFamily:'sans-serif',fontSize:60,color:'#fff',outlineColor:'#000',outlineWidth:2,bold:false,italic:false,align:'center',transform:{x:0,y:0,scale:1,opacity:1}};
          const a=v.textImage(t), b=v.textImage({...t, text:'夕暮'}); const c=v.textImage(t,{vertical:true}), d=v.textImage({...t, text:'夕暮'},{vertical:true});
          return [a.height>b.height, a.width===b.width, c.width>d.width, v.textCharCount('夕暮《ゆうぐれ》です')]}""")
        check("ルビ：テキストは上（縦書きは右）にルビの分だけ広がり、文字数はルビを数えない", r == [True, True, True, 4], str(r))
        await q.wait_for_timeout(300)
        check("ルビの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── 速さ・だんだん速く・逆再生・静止（素材の対応は書き出しの render.rs と同じ）
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const m=await import('/src/model.ts');
          const base={id:'x', trackId:'V1', linkId:null, type:'media', src:'/m/a.mp4', mediaKind:'video', hasAudio:true, volume:1, transform:{x:0,y:0,scale:1,opacity:1}};
          const sp={...base, start:100, duration:60, inPoint:30, speed:2};
          const rv={...base, start:100, duration:60, inPoint:0, reverse:true};
          const rp={...base, start:100, duration:60, inPoint:0, speed:1, speedTo:3};
          const L=m.retime(rp,100,30), R=m.retime(rp,130,30), T=m.retime(rv,100,40), H=m.retime(rv,120,40);
          return [m.srcFrameAt(sp,10), m.retime(sp,130,30).inPoint, m.srcFrameAt(rv,0), m.srcFrameAt(rv,59), m.srcFrameAt(T,0)===m.srcFrameAt(rv,0), m.srcFrameAt(H,0)===m.srcFrameAt(rv,20),
            m.srcSpan(rp), [L.speed,L.speedTo,m.srcSpan(L)], [R.speed,R.speedTo,R.inPoint,m.srcSpan(R)], m.withSpeed(sp,1).duration, m.withSpeed({...base,start:0,duration:60,inPoint:0},1,3).duration, m.speedAt(rv,5)]}""")
        check("速さ：素材の位置・分けたときの切り出し・逆再生の端・だんだん速くの分け方・長さの変わり方", r == [50, 90, 60, 1, True, True, 120, [1, 2, 45], [2, 3, 45, 75], 120, 30, -1], str(r))
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const p=s.getState().project; const fps=p.video.fps;
          const base={trackId:'V1', type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, src:'/m/a.mp4', hasAudio:false};
          const later=p.clips.filter(c=>c.start>=1000).map(c=>[c.id,c.start]);
          s.commit(pr=>({...pr, clips:[...pr.clips, {...base, id:'sv', start:900, duration:120, mediaKind:'video', linkId:'lkS'}, {...base, id:'sa', trackId:(pr.tracks.find(t=>t.kind==='audio')??pr.tracks[pr.tracks.length-1]).id, start:900, duration:120, mediaKind:'audio', linkId:'lkS'}]}));
          s.setMediaSpeed('sv', 2); const a=s.getState().project.clips; const sv=a.find(c=>c.id==='sv'), sa=a.find(c=>c.id==='sa');
          const ok1=sv.duration===60 && sa.duration===60 && sa.speed===2;
          s.setMediaSpeed('sv', 1); s.freezeFrame('sv', 930, 2); const b2=s.getState().project.clips;
          const still=b2.find(c=>c.freeze); const right=b2.filter(c=>c.linkId && c.linkId!=='lkS' && c.start===930+2*fps);
          const moved=later.every(([id,st])=>b2.find(c=>c.id===id).start===st+2*fps);
          return [ok1, !!still && still.start===930 && still.duration===2*fps && still.inPoint===30, right.length===2 && right.every(c=>c.inPoint===30), moved]}""")
        check("速さ：リンクした音も一緒に変わる／再生位置で止めると間に静止したコマが入り、後ろがずれる", r == [True, True, True, True], str(r))
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({selectedClipId:'sv', selectedClipIds:['sv']})}")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.get_by_role("radio", name="2×").click(); await q.wait_for_timeout(300)
        r = await q.evaluate("async()=>{const s=await import('/src/store.ts'); const c=s.getState().project.clips.find(c=>c.id==='sv'); return [c.speed, c.duration]}")
        check("速さ：プロパティの 2× で倍速になり、長さが半分になる", r == [2, 15], str(r))
        await q.wait_for_timeout(300)
        check("速さの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── キーフレーム：何点でも、点から点へ。再生位置に追加・その点の値を変える・ドラッグで点を動かす
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const m=await import('/src/model.ts'); const T=(x)=>({x,y:0,scale:1,opacity:1});
          const look={...m.plainLook(), anim:{to:T(60), rotation:0, ease:'linear', keys:[{at:0.5,transform:T(-40),rotation:0},{at:0.25,transform:T(100),rotation:0}]}};
          const c={transform:T(0), look:{...m.plainLook()}};
          const a=m.setKeyframe(c,0.5,T(80),10); const b2=m.setKeyframe(a,0.501,T(90),0); const d=m.removeKeyframe(b2,0.5);
          return [m.animStateAt(T(0),look,0.375).transform.x, m.animStateAt(T(0),look,0.125).transform.x, m.keyframeTimes(look),
            [a.look.anim.to.x, a.look.anim.keys.length, m.animStateAt(a.transform,a.look,0.5).transform.x, m.animStateAt(a.transform,a.look,0.5).rotation], [b2.look.anim.keys.length, b2.look.anim.keys[0].transform.x], d.look.anim.keys.length]}""")
        check("キーフレーム：点から点へ動く・同じ時点の点は置き換え・消せる", r == [30, 50, [0, 0.25, 0.5, 1], [0, 1, 80, 10], [1, 90], 0], str(r))
        tid = await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({playhead:300}); const id=s.addVisualItem('shape'); const c=s.getState().project.clips.find(x=>x.id===id); s.setState({selectedClipId:id, selectedClipIds:[id], playhead:c.start+Math.round(c.duration/2)}); return id}")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.get_by_role("button", name="再生位置に追加").click(); await q.wait_for_timeout(300)
        n = await q.get_by_text("点 3 個（頭と終わりを含む）").count()
        r = await q.evaluate(f"async()=>{{const s=await import('/src/store.ts'); const c=s.getState().project.clips.find(x=>x.id==='{tid}'); return [c.look.anim.keys.length, Math.abs(c.look.anim.keys[0].at-0.5)<0.02]}}")
        check("キーフレーム：プロパティの「再生位置に追加」で点が増え、数が出る", n == 1 and r == [1, True], f"{n} {r}")
        # プレビューでドラッグしたつもり（矢印キーと同じ道）で、再生位置の点だけが動く
        r = await q.evaluate(f"""async()=>{{const s=await import('/src/store.ts'); const m=await import('/src/model.ts'); const P=await import('/src/preview/Preview.tsx');
          const c=s.getState().project.clips.find(x=>x.id==='{tid}'); const f=(s.getState().playhead-c.start)/c.duration; const st=m.animStateAt(c.transform,c.look,f).transform;
          const target={{kind:'media', id:c.id, key:'m:'+c.id, rect:{{x:0,y:0,w:1,h:1}}, transform:c.transform}};
          P.commitTransform(target,{{...c.transform, x:c.transform.x+20}},'drag:k:1'); P.commitTransform(target,{{...c.transform, x:c.transform.x+50}},'drag:k:1');
          const d=s.getState().project.clips.find(x=>x.id==='{tid}');
          return [d.look.anim.keys.length, d.look.anim.keys[0].transform.x-st.x, d.transform.x===c.transform.x, d.look.anim.to.x===c.look.anim.to.x]}}""")
        check("キーフレーム：ドラッグは再生位置の点だけを、動かし始めからのずれの分だけ動かす", r == [1, 50, True, True], str(r))
        await q.wait_for_timeout(300)
        check("キーフレームの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── 切り抜き・色を抜く・形で切り抜く：書き出しの試験（render.rs の crop_chroma_mask_cut_the_right_pixels）と同じ画素になる
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts');
          const src=document.createElement('canvas'); src.width=64; src.height=36; const x=src.getContext('2d'); x.fillStyle='#00ff00'; x.fillRect(0,0,64,36); x.fillStyle='#ff0000'; x.fillRect(16,9,32,18);
          const base={id:'m', type:'media', mediaKind:'image', src:'x', inPoint:0, volume:1, hasAudio:false, transform:{x:0,y:0,scale:1,opacity:1}};
          const at=(res,X,Y)=>{const c=document.createElement('canvas'); c.width=64; c.height=36; const g=c.getContext('2d'); g.fillStyle='#000'; g.fillRect(0,0,64,36);
            const [w,h]=res.size; g.drawImage(res.img,(64-w)/2,(36-h)/2,w,h); const d=g.getImageData(X,Y,1,1).data; const [R,G]=[d[0],d[1]];
            return R>150&&G<100?'R':G>150&&R<100?'G':R<40&&G<40?'K':'?'};
          const run=(fx)=>v.sourceView(src,[64,36],{...base,...fx},false);
          const k=run({chroma:{color:'#00ff00',similarity:0.4,blend:0.1}}), e=run({mask:{shape:'ellipse',x:0,y:0,w:0.6,h:0.6,radius:0,feather:0,invert:false}});
          const iv=run({mask:{shape:'rect',x:0,y:0,w:0.6,h:0.6,radius:0.2,feather:0,invert:true}}), c=run({crop:{left:0,top:0,right:0.5,bottom:0}});
          return [at(k,2,2),at(k,32,18),at(e,2,2),at(e,32,18),at(iv,2,2),at(iv,32,18),at(c,20,18),at(c,40,18),at(c,60,18), c.size]}""")
        check("切り抜き・色抜き・形の切り抜き：プレビューも書き出しと同じ画素", r == ['K', 'R', 'K', 'R', 'G', 'K', 'G', 'R', 'K', [32, 36]], str(r))
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); const base={trackId:'V1', type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, src:'/m/a.png', hasAudio:false, linkId:null}; s.commit(pr=>({...pr, clips:[...pr.clips, {...base, id:'im', start:0, duration:60, mediaKind:'image'}]})); s.setState({selectedClipId:'im', selectedClipIds:['im']})}")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.get_by_role("radio", name="丸").click(); await q.wait_for_timeout(200)
        await q.get_by_label("背景の色を抜く").click(); await q.wait_for_timeout(200)
        r = await q.evaluate("async()=>{const s=await import('/src/store.ts'); const c=s.getState().project.clips.find(c=>c.id==='im'); return [c.mask?.shape, c.chroma?.color]}")
        check("切り抜き：プロパティで丸の形と色抜きを付けられる", r == ['ellipse', '#00FF00'], str(r))
        await q.wait_for_timeout(300)
        check("切り抜きの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── フィルター・色温度・背景をぼかして埋める（書き出しの render.rs の grade_temperature_fill_blur と同じ）
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts');
          const paint=(color,fx)=>{const c=document.createElement('canvas'); c.width=8; c.height=8; const g=c.getContext('2d'); const f=fx?v.gradeFilter(fx):null; if(f) g.filter=f; g.fillStyle=color; g.fillRect(0,0,8,8); return Array.from(g.getImageData(4,4,1,1).data).slice(0,3)};
          const [nr,ng,nb]=paint('#ff0000',{kind:'grade',name:'noir',strength:1}); const z=paint('#ff0000',{kind:'grade',name:'noir',strength:0}); const [tr,,tb]=paint('#808080',{kind:'temperature',warm:1,tint:0});
          const src=document.createElement('canvas'); src.width=16; src.height=36; const sg=src.getContext('2d'); sg.fillStyle='#ff0000'; sg.fillRect(0,0,16,36);
          const out=document.createElement('canvas'); out.width=64; out.height=36; const og=out.getContext('2d'); og.fillStyle='#000'; og.fillRect(0,0,64,36); v.drawFillBlur(og,src,[16,36],64,36,1,20);
          return [Math.abs(nr-ng)<12&&Math.abs(ng-nb)<12, z[0]>230&&z[1]<25, tr>tb+30, og.getImageData(2,18,1,1).data[0]>150]}""")
        check("フィルター・色温度・背景ぼかし：プレビューも書き出しと同じ色", r == [True, True, True, True], str(r))
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); const base={trackId:'V1', type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, src:'/m/a.png', hasAudio:false, linkId:null}; s.commit(pr=>({...pr, clips:[...pr.clips, {...base, id:'gi', start:0, duration:60, mediaKind:'image'}]})); s.setState({selectedClipId:'gi', selectedClipIds:['gi'], fxTab:'filter'})}")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.locator('[data-fx="gr-film"]').click(); await q.wait_for_timeout(300)
        await q.get_by_label("背景をぼかして埋める").click(); await q.wait_for_timeout(200)
        r = await q.evaluate("async()=>{const s=await import('/src/store.ts'); const c=s.getState().project.clips.find(c=>c.id==='gi'); return [c.look?.effects?.map(e=>e.kind+':'+e.name), c.fillBlur]}")
        n = await q.get_by_label("フィルターの強さ").count()
        check("フィルター：タイルで付き、強さの欄が出る／背景ぼかしを付けられる", r == [['grade:film'], 30] and n >= 1, f"{r} {n}")
        await q.wait_for_timeout(300)
        check("フィルターの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── 音の加工（雑音・音量をそろえる・声を変える）と、拍に印を付ける
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const F=await import('/src/inspector/SoundFxFields.tsx'); const A=await import('/src/audioFx.ts');
          const base={id:'x', trackId:'A1', linkId:null, type:'media', src:'/m/bgm.wav', mediaKind:'audio', hasAudio:true, volume:1, transform:{x:0,y:0,scale:1,opacity:1}};
          const sp={...base, start:100, duration:60, inPoint:30, speed:2}; const rv={...base, start:0, duration:60, inPoint:0, reverse:true};
          let ready=0; const u0=A.processedAudio({...base,start:0,duration:10,inPoint:0,audioFx:{voice:'robot'}}, null, ()=>ready++);
          await new Promise(r=>setTimeout(r,150)); const u1=A.processedAudio({...base,start:0,duration:10,inPoint:0,audioFx:{voice:'robot'}}, null, ()=>{});
          return [F.timelineFrameOf(sp,2,30), F.timelineFrameOf(rv,0.5,30), F.timelineFrameOf(sp,10,30), u0, ready, u1]}""")
        check("音の加工：素材の時刻からタイムラインの位置（速さ・逆再生）／加工した音を作って使う", r == [115, 45, None, None, 1, '/m/bgm.wav'], str(r))
        await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const p=s.getState().project; const tr=(p.tracks.find(t=>t.kind==='audio')??p.tracks[p.tracks.length-1]).id;
          const base={trackId:tr, type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, src:'/m/bgm.wav', hasAudio:true, linkId:null};
          s.commit(pr=>({...pr, markers:[], clips:[...pr.clips, {...base, id:'bg', start:30, duration:300, mediaKind:'audio'}]})); s.setState({selectedClipId:'bg', selectedClipIds:['bg']})}""")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.get_by_label("雑音を減らす").click(); await q.wait_for_timeout(150)
        await q.get_by_label("音量を均一に").click(); await q.wait_for_timeout(300)
        await q.get_by_role("button", name="拍に印を付ける").click(); await q.wait_for_timeout(400)
        r = await q.evaluate("async()=>{const s=await import('/src/store.ts'); const p=s.getState().project; const c=p.clips.find(c=>c.id==='bg'); return [c.audioFx, (p.markers??[]).map(m=>m.frame)]}")
        check("音の加工：プロパティで雑音・音量をそろえる（測った増減）を付け、拍に印が付く", r == [{'denoise': True, 'gainDb': 5}, [45, 60, 75, 90]], str(r))
        await q.wait_for_timeout(300)
        check("音の加工の画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── スタンプ・効果音・場面ごとに分ける・手ぶれ補正・テンプレートのファイル
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const m=await import('/src/model.ts'); const v=await import('/src/preview/visual.ts');
          s.setState({playhead:60}); const id=s.addSticker('bubble'); const c=s.getState().project.clips.find(x=>x.id===id);
          const sizes=m.STICKERS.map(st=>{const im=v.shapeImage({id:'s',type:'shape',shape:st.kind,width:st.w,height:st.h,fill:st.fill,stroke:st.stroke,strokeWidth:st.strokeWidth}); const d=im.getContext('2d').getImageData(0,0,im.width,im.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>0) n++; return n>100});
          return [c.shape, c.width, c.height, c.fill, sizes.every(Boolean), sizes.length]}""")
        check("スタンプ：決まった大きさと色で置け、どのスタンプも描ける", r == ['bubble', 520, 300, '#FFFFFF', True, 11], str(r))
        n = await q.get_by_role("button", name="スタンプ").count() + await q.get_by_role("button", name="効果音").count()
        check("スタンプ・効果音：タイムラインの上にメニューがある", n >= 2, str(n))
        r = await q.evaluate("""async()=>{const A=await import('/src/actions.ts'); const s=await import('/src/store.ts'); s.setState({playhead:900});
          await A.addSfx('pop'); const c=s.getState().project.clips.find(x=>x.type==='media' && x.src==='/sfx/pop.wav'); return c ? [c.mediaKind, c.start] : null}""")
        check("効果音：作った音を再生位置に音声素材として置く", r == ['audio', 900], str(r))
        r = await q.evaluate("""async()=>{const A=await import('/src/actions.ts'); const s=await import('/src/store.ts');
          const base={trackId:'V1', type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, src:'/m/scene.mp4', hasAudio:false, linkId:null, mediaKind:'video'};
          s.commit(pr=>({...pr, clips:[...pr.clips.filter(c=>!(c.trackId==='V1' && c.start<2000)), {...base, id:'sc', start:0, duration:150}]}));
          window.__mockScenes=[1, 2.5, 9]; const n=await A.splitAtScenes('sc');
          const parts=s.getState().project.clips.filter(c=>c.type==='media' && c.src==='/m/scene.mp4').map(c=>[c.start,c.duration,c.inPoint]).sort((a,b)=>a[0]-b[0]);
          return [n, parts]}""")
        check("場面ごとに分ける：変わり目（素材の範囲の外は除く）で分ける", r == [2, [[0, 30, 0], [30, 45, 30], [75, 75, 75]]], str(r))
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); const c=s.getState().project.clips.find(c=>c.src==='/m/scene.mp4'); s.setState({selectedClipId:c.id, selectedClipIds:[c.id]})}")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.get_by_label("手ぶれを抑える").click(); await q.wait_for_timeout(400)
        r = await q.evaluate("async()=>{const s=await import('/src/store.ts'); const c=s.getState().project.clips.find(c=>c.src==='/m/scene.mp4' && c.start===0); return [!!c.stabilize, !!s.getState().proxies['/m/scene.mp4#stab']]}")
        check("手ぶれ補正：付けると、補正したプレビュー用の動画を作り始める", r == [True, True], str(r))
        r = await q.evaluate("""async()=>{const T=await import('/src/templates.ts'); const n0=T.getTemplates().length; T.saveTemplate('placement','左下',{x:-500,y:300,scale:0.8,opacity:1});
          const text=T.templatesToFile(); const n1=T.getTemplates().length; const added=T.templatesFromFile(text); let bad=''; try{T.templatesFromFile('{}')}catch(e){bad=e.message}
          return [n1-n0, added, T.getTemplates().length-n1, bad.includes('テンプレート')]}""")
        check("テンプレート：ファイルに書き出して、読み込むと（名前を変えて）足される", r[0] == 1 and r[1] == r[2] and r[1] >= 1 and r[3], str(r))
        await q.wait_for_timeout(300)
        check("スタンプ・効果音の画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── AI：自動字幕・背景を消す（モデルは初めて使うときにダウンロード）
        q = await fresh(b)
        await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const p=s.getState().project; const tr=(p.tracks.find(t=>t.kind==='audio')??p.tracks[p.tracks.length-1]).id;
          window.__mockSegments=[{start:2,end:3,text:'こんにちは'},{start:4,end:5,text:'さようなら'},{start:20,end:21,text:'範囲の外'}];
          const base={trackId:tr, type:'media', volume:1, transform:{x:0,y:0,scale:1,opacity:1}, src:'/m/talk.wav', hasAudio:true, linkId:null};
          s.commit(pr=>({...pr, clips:[...pr.clips, {...base, id:'tk', start:100, duration:120, inPoint:30, speed:2, mediaKind:'audio'}]})); s.setState({selectedClipId:'tk', selectedClipIds:['tk']})}""")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.get_by_role("button", name="モデルをダウンロード").click(); await q.wait_for_timeout(800)
        await q.get_by_role("button", name="文字起こしして字幕を作る").click(); await q.wait_for_timeout(800)
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const p=s.getState().project; const t=p.tracks.find(t=>t.name==='字幕');
          return t ? p.clips.filter(c=>c.trackId===t.id).map(c=>[c.type, c.start, c.duration, c.text]).sort((a,b)=>a[1]-b[1]) : null}""")
        check("自動字幕：ダウンロードしてから文字起こしし、速さを変えた素材でも聞こえる時刻に字幕を並べる", r == [['text', 115, 15, 'こんにちは'], ['text', 145, 15, 'さようなら']], str(r))
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts'); const {api}=await import('/src/ipc.ts'); const a=await api;
          await a.downloadModel('matte-fast'); const url=await a.makeMatte('/m/p.png', null, 'matte-fast', true, 0); const im=new Image(); im.src=url; await im.decode();
          const src=document.createElement('canvas'); src.width=64; src.height=36; const g=src.getContext('2d'); g.fillStyle='#f00'; g.fillRect(0,0,64,36);
          const m={id:'x', type:'media', mediaKind:'image', src:'/m/p.png', crop:{left:0.25,top:0,right:0,bottom:0}};
          const sv=v.sourceView(src,[64,36],m,false,'',im); const d=sv.img.getContext('2d').getImageData(0,0,sv.img.width,sv.img.height).data;
          const al=(x)=>d[(18*sv.img.width+x)*4+3]; return [sv.img.width, al(4), al(40)]}""")
        check("背景を消す：型の白いところだけ残す（切り抜きと合わせても書き出しと同じ位置）", r[0] == 48 and r[1] > 240 and r[2] < 10, str(r))
        await q.evaluate("""async()=>{const s=await import('/src/store.ts');
          const base={trackId:'V1', type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, src:'/m/person.png', hasAudio:false, linkId:null, mediaKind:'image'};
          s.commit(pr=>({...pr, clips:[...pr.clips.filter(c=>!(c.trackId==='V1' && c.start<300)), {...base, id:'pp', start:0, duration:150}]})); s.setState({selectedClipId:'pp', selectedClipIds:['pp']})}""")
        await q.wait_for_timeout(500)
        await q.get_by_role("button", name="モデルをダウンロード").first.click(); await q.wait_for_timeout(800)
        await q.get_by_label("背景を消す", exact=True).click(); await q.wait_for_timeout(400)
        r = await q.evaluate("async()=>{const s=await import('/src/store.ts'); const c=s.getState().project.clips.find(c=>c.id==='pp'); return [c.matte, !!s.getState().proxies['/m/person.png#matte:matte-fast']?.url]}")
        check("背景を消す：付けると型を作り、プレビューで使う", r == ['matte-fast', True], str(r))
        await q.wait_for_timeout(300)
        check("AI の画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── CapCut の残り：合成モード・LUT・GIF・字幕ファイル・なめらかスロー・自動で位置合わせ・トラッキング
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts');
          const out={};
          const f={multiply:(b,s)=>b*s, screen:(b,s)=>1-(1-b)*(1-s), difference:(b,s)=>Math.abs(b-s), add:(b,s)=>Math.min(1,b+s)};
          for (const m of Object.keys(f)) {
            const c=document.createElement('canvas'); c.width=40; c.height=40; const x=c.getContext('2d'); x.fillStyle='#a04020'; x.fillRect(0,0,40,40);
            const src=document.createElement('canvas'); src.width=10; src.height=10; const g=src.getContext('2d'); g.fillStyle='#2060c0'; g.fillRect(0,0,10,10);
            v.drawVisual(x, src, [10,10], {transform:{x:0,y:0,scale:1,opacity:1}, rotation:0, alpha:0.5, filter:'', blur:0, blend:m}, 40, 40, 1);
            const d=x.getImageData(20,20,1,1).data; const want=[[160,32],[64,96],[32,192]].map(([b,s])=>Math.round((0.5*b/255+0.5*f[m](b/255,s/255))*255));
            out[m]=[...d].slice(0,3).every((v,i)=>Math.abs(v-want[i])<=3) && x.getImageData(2,2,1,1).data[0]===160;
          }
          return out}""")
        check("合成モード：画面でも書き出しと同じ式で下の絵と混ざる（乗算・スクリーン・差・加算）", all(r.values()), str(r))
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts');
          const first=v.lutFilter('/m/swap.cube', 1); await new Promise(r=>setTimeout(r,50)); const f=v.lutFilter('/m/swap.cube', 1); const h=v.lutFilter('/m/swap.cube', 0.5);
          const px=(flt)=>{const c=document.createElement('canvas'); c.width=4; c.height=4; const x=c.getContext('2d'); x.filter=flt; const s=document.createElement('canvas'); s.width=4; s.height=4; const g=s.getContext('2d'); g.fillStyle='#33b266'; g.fillRect(0,0,4,4); x.drawImage(s,0,0); return [...x.getImageData(1,1,1,1).data].slice(0,3)};
          return [first, px(f), px(h), v.lutFilter('/m/bad.txt',1)]}""")
        ok = r[0] is None and all(abs(a-b) <= 3 for a, b in zip(r[1], [0xb2, 0x33, 0x66])) and all(abs(a-b) <= 4 for a, b in zip(r[2], [0x72, 0x72, 0x66]))
        check("LUT：読み終わると画面でも色が変わり、強さで元の色と混ざる", ok, str(r))
        r = await q.evaluate(r"""async()=>{const {parseSubtitles}=await import('/src/srt.ts');
          const a=parseSubtitles('1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>こんにちは</i>\r\n二行目\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nさようなら\r\n', 30);
          const b=parseSubtitles('WEBVTT\n\n00:01.500 --> 00:02.000\nVTT です\n', 30);
          const ac=await import('/src/actions.ts'); const s=await import('/src/store.ts');
          const n=await ac.importSubtitleFile(new File(['1\n00:00:00,500 --> 00:00:01,000\nファイル\n'], 'x.srt'));
          const p=s.getState().project; const t=p.tracks.find(t=>t.name==='字幕');
          return [a, b, n, p.clips.filter(c=>c.trackId===t.id).map(c=>[c.start,c.duration,c.text])]}""")
        check("字幕ファイル：srt・vtt を読み、時刻どおりにテキストで並べる", r[0] == [{'start': 30, 'duration': 45, 'text': 'こんにちは\n二行目'}, {'start': 90, 'duration': 30, 'text': 'さようなら'}] and r[1] == [{'start': 45, 'duration': 15, 'text': 'VTT です'}] and r[2] == 1 and r[3] == [[15, 15, 'ファイル']], str(r))
        r = await q.evaluate("async()=>{const a=await import('/src/actions.ts'); const {api}=await import('/src/ipc.ts'); const x=await api; return (await x.pickSavePath('gif', 'a.gif'))}")
        check("GIF：書き出す先を選べる", r == 'a.gif', str(r))
        await q.evaluate("""async()=>{const s=await import('/src/store.ts');
          const base={type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:3,opacity:1}, src:'/m/walk.mp4', hasAudio:false, linkId:null, mediaKind:'video'};
          s.commit(pr=>({...pr, clips:[...pr.clips.filter(c=>c.trackId!=='V1'), {...base, trackId:'V1', id:'wk', start:0, duration:120, speed:0.5}]})); s.setState({selectedClipId:'wk', selectedClipIds:['wk']})}""")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.get_by_label("なめらかスロー", exact=True).click(); await q.wait_for_timeout(300)
        r = await q.evaluate("async()=>{const s=await import('/src/store.ts'); return s.getState().project.clips.find(c=>c.id==='wk').smooth}")
        check("なめらかスロー：遅くした動画で付けられる", r is True, str(r))
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const a=await import('/src/actions.ts'); const {api}=await import('/src/ipc.ts');
          s.commit(pr=>({...pr, video:{...pr.video, width:1080, height:1920}, clips:pr.clips.map(c=>c.id==='wk'?{...c, speed:undefined, smooth:undefined}:c)}));
          await (await api).downloadModel('matte-fast'); await a.autoReframe('wk', 'matte-fast');
          const c=s.getState().project.clips.find(c=>c.id==='wk'); return [c.transform.x, Math.round(c.transform.scale*1000), c.look.anim?.to.x, (c.look.anim?.keys??[]).length]}""")
        check("自動で位置合わせ：画面いっぱいに広げ、被写体を追って真ん中に置く", r[0] > 500 and r[1] == 5333 and r[2] is not None and r[2] < -500 and r[3] >= 2, str(r))
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const a=await import('/src/actions.ts');
          s.commit(pr=>({...pr, video:{...pr.video, width:1920, height:1080}, clips:pr.clips.map(c=>c.id==='wk'?{...c, transform:{x:0,y:0,scale:3,opacity:1}, look:undefined}:c)}));
          const tr=s.getState().project.tracks.find(t=>t.kind==='video' && t.id!=='V1').id;
          s.commit(pr=>({...pr, clips:[...pr.clips, {id:'tk2', trackId:tr, type:'shape', shape:'star', start:0, duration:60, width:80, height:80, fill:'#fff', stroke:null, strokeWidth:0, cornerRadius:0, transform:{x:30,y:-20,scale:1,opacity:1}, look:{rotation:0, fadeIn:0, fadeOut:0}}]}));
          const v=a.videoUnder('tk2'); await a.trackItem('tk2');
          const c=s.getState().project.clips.find(c=>c.id==='tk2'); return [v?.id, c.transform.x, c.transform.y, c.look.anim?.to.x, c.look.anim?.to.y]}""")
        check("トラッキング：下の動画の中の点を追い、ずれを保ったまま付いて動く", r[0] == 'wk' and r[1] == 30 and r[2] == -20 and r[3] is not None and abs(r[3] - 414) <= 2 and r[4] == -20, str(r))
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({selectedClipId:'tk2', selectedClipIds:['tk2']})}")
        await q.wait_for_timeout(400)
        check("トラッキング：下に動画があるアイテムには「動画の動きに付いていく」が出る", await q.get_by_role("button", name="動画の動きに付いていく").count() == 1)
        check("CapCut の残りの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        # ── 無音カット・モザイク範囲・分割画面
        q = await fresh(b)
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts');
          const out={};
          for (const kind of ['mosaic','blur']) {
            const c=document.createElement('canvas'); c.width=64; c.height=36; const x=c.getContext('2d');
            for (let i=0;i<64;i++){x.fillStyle=i%2?'#fff':'#000'; x.fillRect(i,0,1,36);}
            const sh=document.createElement('canvas'); sh.width=32; sh.height=36; const g=sh.getContext('2d'); g.fillStyle='#f00'; g.fillRect(0,0,32,36);
            v.drawRegion(x, sh, [32,36], {transform:{x:-16,y:0,scale:1,opacity:1}, rotation:0, alpha:1, filter:'', blur:0}, 64, 36, 1, {kind, strength:4});
            const row=(a,b)=>{const d=x.getImageData(a,18,b-a,1).data; const g=[]; for(let i=0;i<d.length;i+=4) g.push(d[i]); return [g, d]};
            const [inn, di]=row(4,28); const [outs]=row(40,60);
            const red=[...Array(di.length/4).keys()].some(i=>di[i*4]>200 && di[i*4+1]<60);
            out[kind]=[Math.max(...inn)-Math.min(...inn), Math.max(...outs)-Math.min(...outs), red];
          }
          return out}""")
        check("モザイク・ぼかし範囲：画面でも形の中だけ下の絵が均され、外は変わらず、図形の色は出ない", all(a < 60 and b > 200 and not red for a, b, red in r.values()), str(r))
        await q.evaluate("""async()=>{const s=await import('/src/store.ts'); s.addRegion('mosaic')}""")
        await q.wait_for_timeout(300)
        r = await q.evaluate("async()=>{const s=await import('/src/store.ts'); const c=s.getState().project.clips.find(c=>c.id===s.getState().selectedClipId); return [c.type, c.shape, c.region?.kind]}")
        check("モザイク範囲：図形メニューから楕円の範囲を置ける", r == ['shape', 'ellipse', 'mosaic'], str(r))
        await q.evaluate("""async()=>{const s=await import('/src/store.ts');
          const vt=s.getState().project.tracks.filter(t=>t.kind==='video'); const at=s.getState().project.tracks.find(t=>t.kind==='audio');
          const base={type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, hasAudio:false, linkId:null};
          s.commit(pr=>({...pr, clips:[...pr.clips.filter(c=>c.type!=='media' && c.type!=='shape'),
            {...base, id:'sa', trackId:vt[0].id, start:0, duration:90, src:'/m/a.mp4', mediaKind:'video'},
            {...base, id:'sb', trackId:vt[1].id, start:0, duration:90, src:'/m/b.png', mediaKind:'image'}]}));
          s.setState({selectedClipId:'sa', selectedClipIds:['sa','sb']})}""")
        await q.get_by_role("tab", name="プロパティ").click(); await q.wait_for_timeout(500)
        await q.get_by_role("button", name="左右 2 分割").click(); await q.wait_for_timeout(500)
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const g=id=>{const c=s.getState().project.clips.find(c=>c.id===id); return [c.transform.x, c.transform.scale, c.crop]}; return [g('sa'), g('sb')]}""")
        check("分割画面：選んだ素材をマスいっぱいに置き、はみ出すところは切り抜く", r == [[-480, 3, {'left': 0.25, 'right': 0.25, 'top': 0, 'bottom': 0}], [480, 2.4, {'left': 0, 'right': 0, 'top': 0.125, 'bottom': 0.125}]], str(r))
        r = await q.evaluate("""async()=>{const s=await import('/src/store.ts'); const a=await import('/src/actions.ts');
          const vt=s.getState().project.tracks.filter(t=>t.kind==='video');
          const base={type:'media', inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, linkId:null};
          s.commit(pr=>({...pr, clips:[...pr.clips.filter(c=>c.type!=='media'), {...base, id:'tl', trackId:vt[0].id, start:0, duration:120, src:'/m/talk.mp4', mediaKind:'video', hasAudio:true},
            {id:'tx9', trackId:vt[1].id, type:'shape', shape:'rect', start:100, duration:10, width:10, height:10, fill:'#fff', stroke:'', strokeWidth:0, transform:{x:0,y:0,scale:1,opacity:1}}]}));
          window.__mockSilence=[[1,2]];
          const sec=await a.cutSilence('tl', {thresholdDb:-38, minLen:0.6, pad:0.15});
          const p=s.getState().project; const pieces=p.clips.filter(c=>c.type==='media').sort((a,b)=>a.start-b.start).map(c=>[c.start,c.duration,c.inPoint]);
          return [Math.round(sec*30), pieces, p.clips.find(c=>c.id==='tx9').start]}""")
        cut = r[0]
        ok = 18 <= cut <= 24 and len(r[1]) == 2 and r[1][0][0] == 0 and r[1][1][0] == r[1][0][1] and r[1][0][1] + r[1][1][1] == 120 - cut and r[1][1][2] == r[1][0][1] + cut and r[2] == 100 - cut
        check("無音カット：静かなところ（前後を少し残す）を切り取って詰め、後ろのアイテムも詰まる", ok, str(r))
        check("無音カット：音のある素材に「静かなところを詰める」が出る", await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({selectedClipId:'tl', selectedClipIds:['tl']}); await new Promise(r=>setTimeout(r,300)); return [...document.querySelectorAll('button')].some(b=>b.textContent.includes('静かなところを詰める'))}"))
        r = await q.evaluate("""async()=>{const pv=await import('/src/preview/Preview.tsx'); const sa=await import('/src/subtitleAnim.ts'); const s=await import('/src/store.ts');
          const p=s.getState().project; const ch={...p.characters[0], subtitle:{...p.characters[0].subtitle, animation:'karaoke', color:'#FFFFFF', outlineWidth:0, shadowColor:'', boxColor:'', fontSize:120, position:'middle'}};
          const c=document.createElement('canvas'); c.width=p.video.width/2; c.height=p.video.height/2; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,c.width,c.height);
          pv.drawSubtitle(x, 'WWWW', ch, p, 0.5, 27, 60);
          const d=x.getImageData(0,0,c.width,c.height).data; const cols=[];
          for (let X=0; X<c.width; X++) { for (let Y=0; Y<c.height; Y++) { const i=(Y*c.width+X)*4; if (d[i]+d[i+1]+d[i+2]>400) { cols.push(d[i+2]<120); break; } } }
          const yl=cols.filter(v=>v).length/cols.length;
          return [sa.karaokeBounds([...'あい、う'], 100, 30), cols.length, Math.round(yl*100), cols.slice(0, cols.length/4|0).every(v=>v), cols.slice(cols.length*3/4|0).every(v=>!v)]}""")
        check("カラオケ字幕：書き出しと同じ区切りで、時間の分だけ左から塗る", r[0] == [0, 91, 182, 209, 300] and r[1] > 40 and abs(r[2] - 50) <= 12 and r[3] and r[4], str(r))
        # ── お手本の動画の編集：クリッピング解除・字幕のグラデーション
        r = await q.evaluate("""async()=>{const v=await import('/src/preview/visual.ts');
          const st=v.visualAt({x:0,y:0,scale:1,opacity:1}, {rotation:0, fadeIn:0, fadeOut:0, enter:{kind:'wipeRight', frames:30}}, 15, 90, 30, 0.5, [64,36]);
          const c=document.createElement('canvas'); c.width=64; c.height=36; const x=c.getContext('2d');
          const im=document.createElement('canvas'); im.width=40; im.height=20; const g=im.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,40,20);
          v.drawVisual(x, im, [40,20], st, 64, 36, 1);
          const a=(X)=>x.getImageData(X,18,1,1).data[3];
          const st2=v.visualAt({x:0,y:0,scale:1,opacity:1}, {rotation:0, fadeIn:0, fadeOut:0, exit:{kind:'wipeDown', frames:30}}, 75, 90, 30, 2.5, [64,36]);
          return [st.wipe, a(14), a(38), a(46), st2.wipe]}""")
        check("クリッピング解除（アイテム）：左から広がって現れ、退場は上から消える（書き出しと同じ式）", r[0] == [0, 0, 0.25, 0] and r[1] > 200 and r[2] > 200 and r[3] < 10 and r[4] == [0, 0.25, 0, 0], str(r))
        r = await q.evaluate("""async()=>{const pv=await import('/src/preview/Preview.tsx'); const sa=await import('/src/subtitleAnim.ts'); const s=await import('/src/store.ts');
          const p=s.getState().project; const mk=(o)=>({...p.characters[0], subtitle:{...p.characters[0].subtitle, color:'#FFFFFF', outlineWidth:0, shadowColor:'', boxColor:'', fontSize:120, position:'middle', ...o}});
          const draw=(ch, f, txt='WWWW')=>{const c=document.createElement('canvas'); c.width=p.video.width/2; c.height=p.video.height/2; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,c.width,c.height);
            pv.drawSubtitle(x, txt, ch, p, 0.5, f, 60); const d=x.getImageData(0,0,c.width,c.height).data; const cols=[];
            for (let X=0; X<c.width; X++) { for (let Y=0; Y<c.height; Y++) { const i=(Y*c.width+X)*4; if (d[i]+d[i+1]+d[i+2]>300) { cols.push([X, d[i+1]<120]); break; } } } return cols};
          const [x1,x2,ms]=sa.wipeBounds('WWWW', 120, p.video.width, 60, 30);
          const mid=draw(mk({animation:'wipe'}), 7.5); const done=draw(mk({animation:'wipe'}), 30);
          const cut=(x1+(x2-x1)*(250/ms))*0.5;
          return [sa.wipeBounds('あいう', 56, 1920, 90, 30), mid.length>0 && mid.every(c=>c[0]<cut+2), mid.length < done.length*3/4]}""")
        check("クリッピング解除（字幕）：書き出しと同じ範囲・速さで左から現れる", r[0] == [859, 1061, 500] and r[1] and r[2], str(r))
        r = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts'); const m=await import('/src/model.ts');
          const vc={id:'v', trackId:'V1', start:0, duration:30, type:'voice', characterId:'x', text:'カニ', subtitle:null};
          const sc={fontFamily:'sans-serif', fontSize:80, color:'#FFFF00', outlineColor:'#000000', outlineWidth:0, bold:true, italic:false, align:'center', transform:{x:0,y:0,scale:1,opacity:1}, gradientColor:'#FF0000'};
          const c=v.subtitleImage(vc, sc); const x=c.getContext('2d'); const d=x.getImageData(0,0,c.width,c.height).data;
          let top=null, bot=null; for (let Y=0; Y<c.height; Y++) for (let X=0; X<c.width; X++) { const i=(Y*c.width+X)*4; if (d[i+3]>250) { if (!top) top=[d[i],d[i+1]]; bot=[d[i],d[i+1]]; } }
          return [null, top, bot]}""")
        check("個別に設定した字幕：グラデーション（上は黄色、下は赤）", r[1] is not None and r[1][1] > 150 and r[2][1] < r[1][1] - 60, str(r))
        # ── 反転・縦横の倍率・回転の中心・3D 回転（core/src/render.rs の flip_stretch_pivot_tilt と同じ数）
        r = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts');
          const shot=(iw, ih, fill, look)=>{const im=document.createElement('canvas'); im.width=iw; im.height=ih; const g=im.getContext('2d'); fill(g);
            const st=v.visualAt({x:0,y:0,scale:1,opacity:1}, {rotation:0, fadeIn:0, fadeOut:0, ...look}, 3, 90, 30, 0.1, [64,36]);
            const sv=v.itemSource(im, [iw,ih], look, st, 0.1, 1);
            const c=document.createElement('canvas'); c.width=64; c.height=36; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,64,36);
            v.drawVisual(x, sv.img, sv.size, sv.st, 64, 36, 1); const d=x.getImageData(0,0,64,36).data; return (X,Y)=>d[(Y*64+X)*4]};
          const white=(g)=>{g.fillStyle='#fff'; g.fillRect(0,0,99,99)};
          const a=shot(40,20,(g)=>{g.fillStyle='#fff'; g.fillRect(0,0,20,20)}, {flipX:true});
          const b=shot(20,20,white,{stretch:[2,0.5]});
          const c=shot(8,8,white,{rotation:180, pivot:[10,0]});
          const t=shot(40,20,white,{rot3d:[0,60]});
          const u=shot(40,20,white,{rot3d:[60,0]});
          const xs=[]; for (let X=0;X<64;X++) if (t(X,18)>128) xs.push(X);
          let hg=0; for (let Y=0;Y<36;Y++) if (u(32,Y)>128) hg++;
          return [a(16,18)<50 && a(48,18)>200, b(14,18)>200 && b(50,18)>200 && b(9,18)<50 && b(32,11)<50 && b(32,15)>200, c(42,18)>200 && c(32,18)<50, xs.length, xs[0], hg]}""")
        check("左右反転（書き出しと同じ向き）", r[0], str(r))
        check("横と縦で別の倍率（書き出しと同じ大きさ）", r[1], str(r))
        check("回転の中心を変えると、その点を中心に回る（書き出しと同じ位置）", r[2], str(r))
        check("3D 回転：Y 軸で傾けると横が縮み、手前側が広い（書き出しは x = 24〜44 の 21px）", abs(r[3] - 21) <= 2 and abs(r[4] - 24) <= 1, str(r))
        check("3D 回転：X 軸で傾けると縦が縮む（書き出しは 10px）", abs(r[5] - 10) <= 1, str(r))
        # ── エフェクトを増やした（core/src/render.rs の more_effects・trail_behind と同じ数）
        r = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts');
          const shot=(iw, ih, fill, look, at=0.1, tr={x:0,y:0,scale:1,opacity:1})=>{const im=document.createElement('canvas'); im.width=iw; im.height=ih; const g=im.getContext('2d'); fill(g);
            const L={rotation:0, fadeIn:0, fadeOut:0, ...look}; const c=document.createElement('canvas'); c.width=64; c.height=36; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,64,36);
            const one=(loc, mul)=>{const st=v.visualAt(tr, L, loc, 90, 30, loc/30, [64,36]); st.alpha*=mul; const sv=v.itemSource(im, [iw,ih], L, st, loc/30, 1, 30); v.drawVisual(x, sv.img, sv.size, sv.st, 64, 36, 1); return st};
            const st=v.visualAt(tr, L, at*30, 90, 30, at, [64,36]);
            if (st.trail) { const [n,iv]=st.trail; for (let j=n;j>=1;j--) { const loc=at*30-j*iv; if (loc>=0) one(loc, 1-j/(n+1)); } }
            one(at*30, 1);
            const d=x.getImageData(0,0,64,36).data; return (X,Y)=>[d[(Y*64+X)*4], d[(Y*64+X)*4+1], d[(Y*64+X)*4+2]]};
          const white=(g)=>{g.fillStyle='#fff'; g.fillRect(0,0,99,99)};
          const fx=(e)=>({effects:[e]});
          const a=shot(10,10,white,fx({kind:'outline', color:'#ff0000', width:4}))(39,18);
          const b=shot(10,10,white,fx({kind:'shadow', color:'#ff0000', blur:0, x:8, y:0, opacity:1}));
          const c=shot(10,10,white,fx({kind:'glow', color:'#ff0000', blur:3, strength:2}));
          const d1=shot(10,10,white,fx({kind:'blink', speed:1}),0.1)(32,18)[0], d2=shot(10,10,white,fx({kind:'blink', speed:1}),0.6)(32,18)[0];
          const e=shot(10,10,white,fx({kind:'rgbShift', amount:3}));
          const f=shot(10,10,white,fx({kind:'dirBlur', length:10, angle:0}));
          const g1=shot(10,10,(g)=>{g.fillStyle='#666'; g.fillRect(0,0,10,10)},fx({kind:'threshold', level:0.5}))(32,18)[0];
          const g2=shot(10,10,(g)=>{g.fillStyle='#999'; g.fillRect(0,0,10,10)},fx({kind:'threshold', level:0.5}))(32,18)[0];
          const o=shot(4,4,white,fx({kind:'oscillate', x:10, y:0, speed:0.25}),1.0);
          const m=await import('/src/model.ts'); const [jx,jy]=m.jitterAt(10,2,1.0);
          const j=shot(2,2,white,fx({kind:'jitter', amount:10, speed:2}),1.0);
          const tl=shot(4,4,white,{anim:{to:{x:170,y:0,scale:1,opacity:1}, rotation:0, ease:'linear'}, effects:[{kind:'trail', count:2, interval:6}]},0.6,{x:-30,y:0,scale:1,opacity:1});
          return {a, b:[b(42,18),b(46,18)], c:[c(38,18),c(39,18)], d:[d1,d2], e:[e(38,18),e(25,18)], f:[f(38,18)[0],f(31,18)[0]], g:[g1,g2], o:[o(42,18)[0],o(32,18)[0]], j:[jx,jy,j(Math.round(31+jx)+1, Math.round(18+jy-1))[0]], t:[tl(42,18)[0],tl(29,18)[0],tl(15,18)[0]], h:m.hash01(3,4)}}""")
        r2 = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts');
          const shot=(iw, ih, fill, look, at=0.1)=>{const im=document.createElement('canvas'); im.width=iw; im.height=ih; const g=im.getContext('2d'); fill(g);
            const L={rotation:0, fadeIn:0, fadeOut:0, ...look}; const tr={x:0,y:0,scale:1,opacity:1}; const c=document.createElement('canvas'); c.width=64; c.height=36; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,64,36);
            const st=v.visualAt(tr, L, at*30, 90, 30, at, [64,36]); const sv=v.itemSource(im, [iw,ih], L, st, at, 1, 30); v.drawVisual(x, sv.img, sv.size, sv.st, 64, 36, 1);
            const d=x.getImageData(0,0,64,36).data; return (X,Y)=>[d[(Y*64+X)*4], d[(Y*64+X)*4+1], d[(Y*64+X)*4+2]]};
          const fill=c=>g=>{g.fillStyle=c; g.fillRect(0,0,99,99)}; const fx=e=>({effects:[e]});
          const grad=g=>{for(let X=0;X<10;X++){g.fillStyle=`rgb(${X*25},${X*25},${X*25})`; g.fillRect(X,0,1,10)}};
          const vg=shot(10,10,fill('#fff'),fx({kind:'vignette', amount:1})), fm=shot(10,10,fill('#808080'),fx({kind:'film', amount:1})), ct=shot(10,10,fill('#fff'),fx({kind:'crt', amount:1}));
          const ps=shot(10,10,fill('#999'),fx({kind:'posterize', levels:3})), dt=shot(10,10,grad,fx({kind:'pixelate', size:5})), vh=shot(10,10,fill('#fff'),fx({kind:'vhs', amount:1}));
          const plain=shot(10,10,fill('#fff'),{});
          const row=f=>Array.from({length:30},(_,i)=>f(17+i,18)); return {vg:[vg(27,18),vg(32,18)], fm:fm(32,18), ct:[ct(27,18),ct(29,18),ct(31,18)], ps:ps(32,18), dt:[25,27,28,31,32,36,37].map(X=>dt(X,18)[0]), vh:[row(vh).slice(0,10), row(vh).slice(20), plain(20,18)]}}""")
        near = lambda a, b, d: all(abs(x - y) <= d for x, y in zip(a, b))
        check("周辺減光（書き出しと同じ：辺の真ん中 159、真ん中 253。画面は 1px 右）", abs(r2['vg'][0][0] - 159) <= 8 and r2['vg'][1][0] >= 245, str(r2))
        check("古いフィルム（書き出しと同じセピア：199・180・145）", near(r2['fm'], [199, 180, 145], 10), str(r2))
        check("ブラウン管（2px ごとに赤・緑・青の縦じま）", [max(range(3), key=lambda i: c[i]) for c in r2['ct']] == [0, 1, 2], str(r2))
        check("ポスタリゼーション（3 段階で 60% の灰色は真ん中の 128）", near(r2['ps'], [128, 128, 128], 3), str(r2))
        check("ドット絵風（5px の点は同じ色。書き出しは 50・180 の 2 段）", r2['dt'][1] == r2['dt'][3] and r2['dt'][4] == r2['dt'][5] and r2['dt'][4] > r2['dt'][1] + 100 and r2['dt'][0] == 0, str(r2))
        check("VHS 風（色がにじんで、左の外は青、右の外は赤）", any(c[2] > c[0] + 80 for c in r2['vh'][0]) and any(c[0] > c[2] + 80 for c in r2['vh'][1]) and r2['vh'][2] == [0, 0, 0], str(r2))
        r3 = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts');
          const shot=(iw, ih, fill, look, at=0.1)=>{const im=document.createElement('canvas'); im.width=iw; im.height=ih; const g=im.getContext('2d'); fill(g);
            const L={rotation:0, fadeIn:0, fadeOut:0, ...look}; const tr={x:0,y:0,scale:1,opacity:1}; const c=document.createElement('canvas'); c.width=64; c.height=36; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,64,36);
            const st=v.visualAt(tr, L, at*30, 90, 30, at, [64,36]); const sv=v.itemSource(im, [iw,ih], L, st, at, 1, 30); v.drawVisual(x, sv.img, sv.size, sv.st, 64, 36, 1);
            const d=x.getImageData(0,0,64,36).data; return (X,Y)=>Math.round(0.299*d[(Y*64+X)*4]+0.587*d[(Y*64+X)*4+1]+0.114*d[(Y*64+X)*4+2])};
          const fx=e=>({effects:[e]}); const fill=c=>g=>{g.fillStyle=c; g.fillRect(0,0,99,99)};
          const half=g=>{g.fillStyle='#fff'; g.fillRect(0,0,20,20); g.fillStyle='#000'; g.fillRect(20,0,20,20)};
          const ramp=g=>{for(let X=0;X<40;X++){const u=Math.round(X*5*255/219); g.fillStyle=`rgb(${u},${u},${u})`; g.fillRect(X,0,1,20)}};
          const row=(f,y=18)=>Array.from({length:45},(_,i)=>f(10+i,y));
          const ht=shot(20,20,fill('#808080'),fx({kind:'halftone', size:10, ink:'#000000'})); const ll=shot(20,20,fill('#404040'),fx({kind:'lightLeak', color:'#FF9A3C', amount:1}));
          return {la:row(shot(40,20,half,fx({kind:'lineArt', amount:1, keepColor:false}))), ht:Array.from({length:21},(_,i)=>ht(27,8+i)), bl:row(shot(40,20,half,fx({kind:'bloom', threshold:0.5, amount:1, radius:4}))),
            ll:[ll(22,8),ll(31,18),ll(41,27)], ll1:[ll(23,9),ll(32,19),ll(42,28)], lf:row(shot(20,20,fill('#404040'),fx({kind:'lensFlare', x:0.5, y:-0.5, amount:1, color:'#FFE0A0'})),13),
            bu:row(shot(40,20,ramp,fx({kind:'bulge', amount:1}))), ka:row(shot(40,20,ramp,fx({kind:'mirror', mode:'kaleido', segments:6}))), tf:row(shot(40,20,ramp,fx({kind:'tile', count:3, flip:true}))),
            du:row(shot(40,20,ramp,fx({kind:'duotone', dark:'#000080', light:'#FFFF00', amount:1})))}}""")
        # 書き出し（core/src/render.rs の more_effects と同じ絵）で読んだ値。画面は 1px ずれることがあるので、ずらして比べる
        ref = {
            'la': [0, 0] + [255] * 19 + [0, 0] + [255] * 19 + [0, 0],
            'bl': [0, 0] + [255] * 20 + [103, 73, 52, 36, 25, 17, 12, 9, 5, 3, 3, 2, 2, 1, 1, 1, 0, 0, 0, 0, 0, 0],
            'lf': [0] * 12 + [73, 75, 80, 86, 92, 99, 108, 118, 127, 141, 156, 172, 191, 220, 252, 252, 252, 220, 191, 172] + [0] * 12,
            'bu': [0, 0, 0, 4, 10, 17, 23, 29, 33, 39, 46, 52, 58, 64, 69, 78, 86, 93, 98, 104, 109, 114, 116, 116, 121, 125, 131, 138, 145, 152, 160, 166, 173, 180, 186, 192, 196, 202, 208, 215, 221, 221, 0, 0],
            'ka': [0, 0, 221, 220, 214, 208, 201, 195, 190, 185, 179, 173, 166, 161, 156, 150, 144, 138, 131, 126, 121, 116, 116, 122, 128, 132, 138, 145, 151, 157, 163, 167, 173, 180, 186, 192, 196, 202, 208, 215, 221, 221, 0, 0],
            'tf': [0, 0, 0, 17, 33, 52, 68, 87, 103, 122, 138, 157, 173, 192, 208, 221, 221, 202, 186, 167, 150, 132, 116, 97, 81, 62, 45, 29, 10, 3, 23, 39, 58, 74, 91, 109, 126, 145, 163, 180, 196, 214, 0, 0],
            'du': [0, 0, 14, 17, 22, 28, 32, 37, 42, 46, 51, 56, 62, 67, 71, 75, 80, 86, 90, 94, 99, 104, 109, 114, 120, 123, 128, 134, 138, 143, 149, 152, 157, 163, 168, 173, 177, 180, 186, 192, 196, 196, 0, 0],
        }
        def close_row(got, want, tol, skip=0):
            best = None
            for off in (0, 1):
                d = [abs(got[i + off] - w) for i, w in enumerate(want) if i + off < len(got)]
                d = sorted(d)[: len(d) - skip] if skip else d
                m = max(d)
                best = m if best is None else min(best, m)
            return best <= tol, best
        for key, label, tol, skip in [('la', '線画風：境目だけ黒い線', 40, 2), ('bl', 'ブルーム：明るい所が暗い側へにじむ', 40, 2), ('lf', 'レンズフレア：右上に光と筋', 30, 2), ('bu', '魚眼：真ん中が広がる', 14, 2), ('ka', '万華鏡：真ん中で折り返す', 14, 2), ('tf', 'タイル（裏返し）：3 回くり返す', 14, 2), ('du', 'デュオトーン：紺から黄へ', 14, 2)]:
            ok, m = close_row(r3[key], ref[key], tol, skip)
            check(f"{label}（書き出しと同じ。いちばん大きい差 {m}）", ok, str(r3[key]))
        r4 = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts');
          const im=document.createElement('canvas'); im.width=40; im.height=20; const g=im.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,20,20); g.fillStyle='#000'; g.fillRect(20,0,20,20);
          const L={rotation:0, fadeIn:0, fadeOut:0, effects:[{kind:'glitchNoise', amount:1, rate:1, block:8}]}; const tr={x:0,y:0,scale:1,opacity:1};
          const c=document.createElement('canvas'); c.width=64; c.height=36; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,64,36);
          const st=v.visualAt(tr, L, 3, 90, 30, 0.1, [64,36]); const sv=v.itemSource(im, [40,20], L, st, 0.1, 1, 30); v.drawVisual(x, sv.img, sv.size, sv.st, 64, 36, 1);
          const d=x.getImageData(0,0,64,36).data; const gy=(X,Y)=>Math.round(0.299*d[(Y*64+X)*4]+0.587*d[(Y*64+X)*4+1]+0.114*d[(Y*64+X)*4+2]);
          return Array.from({length:36},(_,Y)=>Array.from({length:64},(_,X)=>gy(X,Y)))}""")
        gn = {
            14: [0, 0, 0, 0, 0, 0, 12, 28, 29, 29, 47, 172, 178, 215, 251, 251, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 236, 225, 224, 224, 203, 83, 74, 46, 2, 2] + [0] * 28,
            18: [0, 0, 0, 0, 0, 0, 0, 0, 22, 28, 51, 169, 178, 178, 178, 227, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 254, 229, 224, 202, 83, 75, 75, 74, 28] + [0] * 28,
        }
        for y, want in gn.items():
            # 画面は縦にも 1px ずれることがある
            ok, m = min((close_row(r4[y + dy], want, 40, 4) for dy in (0, 1)), key=lambda t: t[1])
            check(f"グリッチノイズ：{y} 行目のずれと色ずれが書き出しと同じ（いちばん大きい差 {m}）", ok, str(r4[y]))
        check("グリッチノイズ：横線のノイズが書き出しと同じ所（22 行目あたり）に出る", any(sum(1 for v in r4[y][12:52] if 30 < v < 225) > 15 for y in (21, 22, 23)), str(r4[22]))
        r5 = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts');
  const shot=(iw, ih, fill, look, at)=>{const im=document.createElement('canvas'); im.width=iw; im.height=ih; const g=im.getContext('2d'); fill(g);
    const L={rotation:0, fadeIn:0, fadeOut:0, ...look}; const tr={x:0,y:0,scale:1,opacity:1}; const c=document.createElement('canvas'); c.width=64; c.height=36; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,64,36);
    const st=v.visualAt(tr, L, at*30, 90, 30, at, [64,36]); const sv=v.itemSource(im, [iw,ih], L, st, at, 1, 30); v.drawVisual(x, sv.img, sv.size, sv.st, 64, 36, 1);
    const d=x.getImageData(0,0,64,36).data; const gy=(X,Y)=>Math.round(0.299*d[(Y*64+X)*4]+0.587*d[(Y*64+X)*4+1]+0.114*d[(Y*64+X)*4+2]);
    return {row:y=>Array.from({length:64},(_,X)=>gy(X,y)), col:X=>Array.from({length:36},(_,y)=>gy(X,y)), rgb:(X,Y)=>[d[(Y*64+X)*4],d[(Y*64+X)*4+1],d[(Y*64+X)*4+2]]}};
  const fill=c=>g=>{g.fillStyle=c; g.fillRect(0,0,99,99)}; const W=fill('#fff');
  const half=(a,b)=>g=>{g.fillStyle=a; g.fillRect(0,0,20,20); g.fillStyle=b; g.fillRect(20,0,20,20)};
  const mo=(k,en)=>en?{enter:{kind:k, frames:15}}:{exit:{kind:k, frames:15}}; const fx=e=>({effects:[e]});
  const o={};
  let s=shot(40,20,W,mo('spin',true),0.25); o.SPIN18=s.row(18); o.SPIN13=s.row(13);
  s=shot(20,20,W,mo('bounce',true),0.35); o.BOUNCE18=s.row(18);
  s=shot(20,20,W,mo('blur',true),0.2); o.BLUR18=s.row(18);
  s=shot(40,20,W,mo('iris',true),0.25); o.IRIS18=s.row(18); o.IRIS10=s.row(10);
  s=shot(40,20,W,mo('iris',false),2.75); o.IRISX18=s.row(18);
  s=shot(20,20,W,fx({kind:'pulse', amount:0.5, bpm:60}),0.05); o.PULSE18=s.row(18);
  s=shot(20,20,W,fx({kind:'spin', rpm:60}),0.125); o.SPINFX18=s.row(18); o.SPINFX8=s.row(8);
  s=shot(20,20,W,fx({kind:'bounce', height:10, bpm:60}),0.5); o.BOUNCEFX31=s.col(31);
  s=shot(20,20,fill('#f00'),fx({kind:'hueCycle', rpm:60, offset:0}),1/3); o.HUE=s.rgb(31,18);
  s=shot(40,20,half('rgb(150,150,150)','rgb(100,100,100)'),fx({kind:'sharpen', amount:1}),0.1); o.SHARP18=s.row(18);
  s=shot(20,20,W,fx({kind:'innerShadow', color:'#000000', blur:0, x:3, y:3, opacity:1}),0.1); o.INNER18=s.row(18); o.INNER31=s.col(31);
  s=shot(20,20,fill('#808080'),fx({kind:'bevel', size:4, strength:1, angle:135}),0.1); o.BEVEL18=s.row(18); o.BEVEL31=s.col(31);
  s=shot(40,20,half('#fff','#000'),fx({kind:'emboss', amount:1, angle:180, keepColor:false}),0.1); o.EMBOSS18=s.row(18);
  return o}""")
        ref5 = {"SPIN18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 160, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "SPIN13": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 201, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "BOUNCE18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "BLUR18": [2, 2, 3, 3, 3, 4, 4, 5, 6, 9, 10, 11, 13, 16, 18, 22, 25, 30, 36, 41, 48, 57, 67, 74, 81, 87, 91, 95, 97, 100, 102, 102, 102, 102, 100, 97, 95, 91, 87, 81, 74, 67, 57, 48, 41, 36, 30, 25, 22, 18, 16, 13, 11, 10, 9, 6, 5, 4, 4, 3, 3, 3, 2, 2], "IRIS18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "IRIS10": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "IRISX18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "PULSE18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "SPINFX18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "SPINFX8": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "BOUNCEFX31": [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "SHARP18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 156, 215, 38, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "INNER18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "INNER31": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0], "BEVEL18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 211, 170, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 85, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "BEVEL31": [0, 0, 0, 0, 0, 0, 0, 0, 255, 211, 170, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 85, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0], "EMBOSS18": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 0, 0, 0, 0, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]}
        def span(a):
            s = sum(a) / 255
            c = sum(i * v for i, v in enumerate(a)) / max(1, sum(a))
            return s, c
        for key, (label, how) in {"SPIN18": ["登場「回転しながら」：途中で 90° 回って 4 分の 3 の大きさ", "w"], "SPIN13": ["登場「回転しながら」（上の方の行）", "w"], "BOUNCE18": ["登場「跳ねて」：行きすぎて元より大きい", "w"], "BLUR18": ["登場「ぼかしから」：ぼけて薄い（8 段のぼかし）", "v"], "IRIS18": ["登場「丸く広がる」：真ん中の丸だけ見える", "w"], "IRIS10": ["登場「丸く広がる」：上の方は丸の幅が狭い", "w"], "IRISX18": ["退場「丸く狭まる」", "w"], "PULSE18": ["拍動：拍の頭で大きくなる", "w"], "SPINFX18": ["回り続ける：45° 回る", "w"], "SPINFX8": ["回り続ける：ひし形の上の角", "w"], "BOUNCEFX31": ["跳ねる：上へ 10px", "v"], "SHARP18": ["シャープ：境目がくっきり", "v"], "INNER18": ["内側の影：左の内側が暗い", "v"], "INNER31": ["内側の影：上の内側が暗い", "v"], "BEVEL18": ["ベベル：左は明るく右は暗い縁", "v"], "BEVEL31": ["ベベル：上は明るく下は暗い縁", "v"], "EMBOSS18": ["エンボス：境目だけ浮き出る", "v"]}.items():
            got, want = r5[key], ref5[key]
            if how == 'w':
                (gs, gc), (ws, wc) = span(got), span(want)
                ok = abs(gs - ws) <= 2.5 and abs(gc - wc) <= 1.5
                check(f"{label}（書き出しと同じ。幅 {gs:.1f}／{ws:.1f}・真ん中 {gc:.1f}／{wc:.1f}）", ok, str(got))
            else:
                ok, m = close_row(got, want, 16, 2)
                check(f"{label}（書き出しと同じ。いちばん大きい差 {m}）", ok, str(got))
        check("色相の回転：赤が 1/3 秒で 120° 回って緑に（書き出しは 0・110・0）", abs(r5['HUE'][1] - 110) <= 8 and r5['HUE'][0] < 10 and r5['HUE'][2] < 10, str(r5['HUE']))
        r6 = await q.evaluate(r"""async()=>{const m=await import('/src/model.ts');
          const img=(id,start)=>({id, type:'media', trackId:'V1', start, duration:60, src:'/x.png', mediaKind:'image', hasAudio:false, inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, look:{rotation:0, fadeIn:0, fadeOut:0}});
          const run=kind=>{const p={video:{width:64,height:36,fps:30,sampleRate:48000,background:'#000'}, tracks:[{id:'V1',kind:'video',name:'',muted:false,locked:false,duck:false,duckLevel:0.3}], characters:[], clips:[img('a',0), {...img('b',60), look:{rotation:0, fadeIn:0, fadeOut:0, transition:{kind, frames:20}}}]};
            const q=m.withTransitions(p); const g=id=>q.clips.find(c=>c.id===id); return {a:[g('a').duration, g('a').look.exit?.kind ?? null, g('a').look.exit?.frames ?? 0], b:[g('b').look.enter?.kind ?? null, g('b').look.enter?.frames ?? 0, !!g('b').look.enter?.smooth], ids:q.clips.map(c=>c.id), gl:g('b~glitch') ? [g('b~glitch').start, g('b~glitch').duration, g('b~glitch').control?.kind, g('b~glitch').look.effects[0].kind] : null}};
          return {iris:run('iris'), wipe:run('wipeDown'), blur:run('blur'), glitch:run('glitch')}}""")
        check("切り替え「円形」「ワイプ」：前を延ばして、次の場面を広げる（書き出しの with_transitions と同じ）", r6['iris']['a'][0] == 80 and r6['iris']['b'] == ['iris', 20, True] and r6['wipe']['b'][0] == 'wipeDown', str(r6))
        check("切り替え「ブラー」：前はぼやけて消え、次はぼやけた所から（半分ずつ）", r6['blur']['a'][1:] == ['blur', 10] and r6['blur']['b'][:2] == ['blur', 10], str(r6['blur']))
        check("切り替え「グリッチ」：つなぎ目の前後に、乱す調整レイヤーが手前に 1 つ", r6['glitch']['gl'] == [50, 20, 'adjust', 'glitchNoise'] and r6['glitch']['ids'][-1] == 'b~glitch', str(r6['glitch']))
        check("網点：50% の灰色は、点の真ん中を通る列がほぼ黒く、点の境目だけ明るい（書き出しは 129・0…0・129）", sum(v < 60 for v in r3['ht']) >= 14 and max(r3['ht']) >= 100, str(r3['ht']))
        check("光漏れ：書き出しと同じだけ明るくなる（139・109・124）", any(all(abs(a - b) <= 15 for a, b in zip(g, [139, 109, 124])) for g in (r3['ll'], r3['ll1'])), str(r3['ll']) + str(r3['ll1']))
        check("縁取り（書き出しと同じく形のまわり 4px が赤）", r['a'][0] > 200 and r['a'][1] < 60, str(r))
        check("ドロップシャドウ（右へ 8px）", r['b'][0][0] > 200 and r['b'][0][1] < 60 and r['b'][1][0] < 30, str(r))
        check("発光（すぐ外が赤みがかる。書き出しは 53・46）", 35 < r['c'][0][0] < 140 and r['c'][0][1] < 30 and r['c'][1][0] > 20, str(r))
        check("点滅（0.1 秒は見え、0.6 秒は見えない）", r['d'][0] > 200 and r['d'][1] < 30, str(r))
        check("色ずれ（右の外は赤、左の外は青）", r['e'][0][0] > r['e'][0][1] + 80 and r['e'][1][2] > r['e'][1][0] + 80, str(r))
        check("方向ブラー（端の外は書き出しと同じく半端な明るさ：64 前後）", 30 < r['f'][0] < 110 and r['f'][1] > 200, str(r))
        check("二値化（40% は黒、60% は白）", r['g'][0] < 30 and r['g'][1] > 220, str(r))
        check("反復移動（1 秒で右に 10px）", r['o'][0] > 200 and r['o'][1] < 30, str(r))
        check("ランダム移動（書き出しと同じ乱数でずれる）", r['j'][2] > 100 and abs(r['h'] - 0.0) >= 0, str(r))
        check("残像（前の時点の位置に薄く重なる）", r['t'][0] > 220 and 140 <= r['t'][1] < 200 and 60 <= r['t'][2] < 110, str(r))
        # ── グループ制御・カメラ・調整レイヤー（core/src/render.rs の group_camera_adjust と同じ数。プレビューに描いて読む）
        async def ctl_shot(kind, layers, tr, look, ph):
            return await q.evaluate(r"""async([kind, layers, tr, look, ph])=>{const s=await import('/src/store.ts');
              const p=structuredClone(s.getState().project); p.video={...p.video, width:64, height:36, background:'#000000'};
              p.tracks=[1,2,3].map(n=>({...p.tracks[0], id:'V'+n, name:'', hidden:false, locked:false, muted:false}));
              const sq=(id,t,x)=>({id, type:'shape', trackId:t, start:0, duration:60, shape:'rect', width:6, height:6, fill:'#FFFFFF', stroke:'', strokeWidth:0, transform:{x, y:0, scale:1, opacity:1}});
              p.clips=[sq('a','V1',-12), sq('b','V2',12), {...sq('g','V3',0), duration:30, transform:{x:0,y:0,scale:1,opacity:1, ...tr}, look:{rotation:0, fadeIn:0, fadeOut:0, effects:[], ...look}, control:{kind, layers}}];
              p.characters=[]; s.setState({project:p, playhead:ph, selectedClipId:null});
              await new Promise(r=>setTimeout(r,250)); const c=document.querySelector('.vx-preview canvas'); const g=c.getContext('2d'); const k=c.width/64;
              const row=[]; for (let X=0;X<64;X++) row.push(g.getImageData(Math.floor((X+0.5)*k), Math.floor(18.5*k), 1, 1).data[0]); return row}""", [kind, layers, tr, look, ph])
        keep = await q.evaluate("async()=>structuredClone((await import('/src/store.ts')).getState().project)")
        a1 = await ctl_shot('group', 2, {'x': 5}, {}, 15)
        b1 = await ctl_shot('group', 2, {'x': 5}, {}, 45)
        c1 = await ctl_shot('group', 1, {'x': 5}, {}, 15)
        o1 = await ctl_shot('group', 2, {'opacity': 0.5}, {}, 15)
        m1 = await ctl_shot('camera', 1, {'x': 5}, {}, 15)
        z1 = await ctl_shot('camera', 1, {'scale': 2}, {}, 15)
        j1 = await ctl_shot('adjust', 1, {}, {'effects': [{'kind': 'invert'}]}, 15)
        await q.evaluate("async(p)=>(await import('/src/store.ts')).setState({project:p, playhead:0})", keep)
        check("グループ制御：まとめた 2 レイヤーが右へ 5px（書き出しと同じ）", a1[25] > 200 and a1[49] > 200 and a1[18] < 30, str(a1))
        check("グループ制御：時間の外は元の位置", b1[18] > 200 and b1[25] < 30, str(b1))
        check("グループ制御：1 レイヤーならすぐ下だけ動く", c1[18] > 200 and c1[49] > 200 and c1[42] < 30, str(c1))
        check("グループ制御：不透明度はまとめて掛かる", 100 <= o1[19] < 160, str(o1))
        check("カメラ：右へ動かすと絵は左へ", m1[14] > 200 and m1[38] > 200 and m1[20] < 30, str(m1))
        check("カメラ：大きくすると真ん中から寄る", z1[4] > 200 and z1[59] > 200 and z1[20] < 30, str(z1))
        check("調整レイヤー：下の全部に掛かる（色の反転）", j1[30] > 220 and j1[19] < 30 and j1[43] < 30, str(j1))
        # ── テキストの縦書き・1 文字ずつ登場
        r = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts'); const m=await import('/src/model.ts');
          const base={id:'t', type:'text', trackId:'V1', start:0, duration:90, text:'あいうえ', fontFamily:'sans-serif', fontSize:40, color:'#FFFFFF', outlineColor:'#000000', outlineWidth:0, bold:false, italic:false, align:'center', transform:{x:0,y:0,scale:1,opacity:1}};
          const h=v.textImage(base), vt=v.textImage({...base, vertical:true});
          // 文字ごとの明るさ（横書き、4 つに分けた区画の不透明なところの数）
          const cols=(img)=>{const d=img.getContext('2d').getImageData(0,0,img.width,img.height).data; const out=[0,0,0,0]; for (let X=0;X<img.width;X++) for (let Y=0;Y<img.height;Y++) if (d[(Y*img.width+X)*4+3]>128) out[Math.min(3,Math.floor(X/img.width*4))]++; return out};
          const ca={kind:'type', interval:5, length:1};
          const f0=cols(v.textImage({...base, charAnim:ca}, {charFrame:0})), f6=cols(v.textImage({...base, charAnim:ca}, {charFrame:6})), fe=cols(v.textImage({...base, charAnim:ca}, {charFrame:100}));
          const fa={kind:'fade', interval:5, length:10};
          const a1=v.textImage({...base, charAnim:fa}, {charFrame:5}); const ad=a1.getContext('2d').getImageData(0,0,a1.width,a1.height).data; let mx=0; for (let i=3;i<ad.length;i+=4) mx=Math.max(mx,ad[i]);
          const same=v.textImage({...base, charAnim:ca}, {charFrame:100}).width===v.textImage({...base, charAnim:ca}, {charFrame:0}).width;
          return {h:[h.width,h.height], v:[vt.width,vt.height], f0, f6, fe, mx, same, frames:m.charAnimFrames(fa,4), p:[m.charProgress(fa,1,10), m.charProgress(ca,2,9)]}}""")
        check("テキストの縦書き：縦に長い画像になる", r['v'][1] > r['v'][0] * 2 and r['h'][0] > r['h'][1] * 2, str(r))
        check("1 文字ずつ（そのまま）：0 コマ目は 1 文字目だけ、6 コマ目は 2 文字目まで、最後は全部", r['f0'][0] > 0 and r['f0'][1] == 0 and r['f6'][1] > 0 and r['f6'][2] == 0 and r['fe'][3] > 0, str(r))
        check("1 文字ずつ（ふわっと）：途中は半分の濃さ、画像の大きさは変わらない", 90 < r['mx'] < 170 and r['same'], str(r))
        check("1 文字ずつ：出きるまでのコマ数（書き出しの CharAnim::frames と同じ）", r['frames'] == 25 and r['p'] == [0.5, 0], str(r))
        # ── シーン（core/src/render.rs の scene_item と同じ数）
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const m=await import('/src/model.ts');
          const keep=structuredClone(s.getState().project); const p=structuredClone(keep); p.video={...p.video, width:64, height:36, background:'#000000'};
          const tr=(id)=>({...p.tracks[0], id, name:'', hidden:false, locked:false, muted:false});
          const sh=(id,t,start,duration,x,scene)=>({id, type:'shape', trackId:t, start, duration, shape:'rect', width:6, height:6, fill:'#FFFFFF', stroke:'', strokeWidth:0, transform:{x, y:0, scale:1, opacity:1}, scene});
          p.tracks=[tr('V1'), tr('V2')]; p.characters=[];
          p.scenes=[{id:'sc', name:'s', tracks:[tr('S1')], clips:[sh('s1','S1',0,20,-10), sh('s2','S1',20,100,10)]}];
          p.clips=[{...sh('it','V2',30,60,5,'sc'), width:64, height:36}];
          const e=m.withScenes(p);
          const ids=e.tracks.map(t=>t.id); const s2=e.clips.find(c=>c.id==='s2@it');
          const row=async(ph)=>{s.setState({project:p, playhead:ph, selectedClipId:null}); await new Promise(r=>setTimeout(r,250)); const c=document.querySelector('.vx-preview canvas'); const g=c.getContext('2d'); const k=c.width/64; const out=[]; for (let X=0;X<64;X++) out.push(g.getImageData(Math.floor((X+0.5)*k), Math.floor(18.5*k),1,1).data[0]); return out};
          const a=await row(36), b=await row(60), z=await row(15);
          // シーンを開いて戻す（保存はいつもメイン）
          const o=m.switchScene(p,'sc'); const back=m.canonicalProject(o);
          s.setState({project:keep, playhead:0});
          return {ids, s2:[s2.start, s2.duration], a, b, zmax:Math.max(...z), open:[o.tracks[0].id, o.sceneId], back:[back.tracks.map(t=>t.id).join(','), back.sceneId===undefined, back.scenes.length]}}""")
        check("シーン：展開したレイヤー（書き出しの with_scenes と同じ）", r['ids'] == ['V1', 'S1@it', 'V2'] and r['s2'] == [50, 40], str(r))
        check("シーン：アイテムの頭から再生して、アイテムの位置に置く（6 フレーム目は x = 24〜29）", r['a'][26] > 200 and r['a'][36] < 30, str(r['a']))
        check("シーン：30 フレーム目は x = 44〜49", r['b'][46] > 200 and r['b'][26] < 30, str(r['b']))
        check("シーン：アイテムの前は何も出ない", r['zmax'] < 30, str(r))
        check("シーンを開く・メインに戻す（保存するのはいつもメイン）", r['open'] == ['S1', 'sc'] and r['back'] == ['V1,V2', True, 1], str(r))
        # ── 音声の波形・スペクトラム（プレビューの目安）
        r = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts');
          const c={id:'z', type:'shape', trackId:'V1', start:0, duration:90, shape:'rect', width:120, height:40, fill:'#FF0000', stroke:'', strokeWidth:0, transform:{x:0,y:0,scale:1,opacity:1}};
          const cnt=(img)=>{const d=img.getContext('2d').getImageData(0,0,img.width,img.height).data; let n=0, red=true; for (let i=0;i<d.length;i+=4) if (d[i+3]>100) { n++; if (d[i+1]>60) red=false; } return [n, red]};
          return [cnt(v.vizImage({...c, viz:'bars'}, 0, 1)), cnt(v.vizImage({...c, viz:'bars'}, 1, 1)), cnt(v.vizImage({...c, viz:'wave'}, 1, 1)), v.vizImage({...c, viz:'wave'}, 1, 1).width]}""")
        check("音声のスペクトラム：音がなければ描かず、音があれば塗りの色で描く", r[0][0] == 0 and r[1][0] > 200 and r[1][1], str(r))
        check("音声の波形：図形の大きさで描く", r[2][0] > 50 and r[3] == 120, str(r))
        # ── プラグイン（core/src/plugin.rs の fills_and_rejects と同じ）
        r = await q.evaluate(r"""async()=>{const m=await import('/src/model.ts'); const v=await import('/src/preview/visual.ts'); const ipc=await import('/src/ipc.ts');
          const a=await ipc.api; const l=await a.listPlugins(); const pl=l.plugins[0].plugin; const e=m.pluginEffect(pl, pl.effects[0]);
          const st=v.visualAt({x:0,y:0,scale:1,opacity:1}, {rotation:0, fadeIn:0, fadeOut:0, effects:[e]}, 0, 30, 30, 0, [64,36]);
          return [m.fillTemplate('hue=h={deg}:s={k}', {deg:90, k:0.25}), m.fillTemplate('hue=h={x}', {deg:90}), m.fillTemplate('null[a];[a]hue', {}), e.values, st.filter]}""")
        check("プラグイン：{名前} に数を入れる（書き出しと同じ）、壊れる式は使わない", r[0] == 'hue=h=90:s=0.25' and r[1] is None and r[2] is None, str(r))
        check("プラグイン：見本のエフェクトを最初の値で入れ、プレビューにも掛かる", r[3] == {'deg': 90} and r[4] == 'hue-rotate(90deg)', str(r))
        # ── 新しいアイテムのプロパティを開いても、画面にエラーが出ない
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const keep=structuredClone(s.getState().project); const out=[];
          const wait=()=>new Promise(r=>setTimeout(r,300));
          for (const id of [s.addControl('group'), s.addControl('camera'), s.addControl('adjust'), s.addAudioViz('wave'), s.addAudioViz('bars')]) { s.setState({selectedClipId:id}); await wait(); out.push(document.querySelector('.vx-inspector, [class*=inspector]')?.textContent?.slice(0,40) ?? ''); }
          const sc=s.addScene(); await wait(); const inScene=s.getState().project.sceneId===sc; s.addVisualItem('text'); s.openScene(null); await wait();
          const it=s.addSceneItem(sc); s.setState({selectedClipId:it}); await wait(); out.push(document.body.textContent.includes('置くシーン'));
          const tx=s.addVisualItem('text'); s.updateClip(tx, {charAnim:{kind:'pop', interval:2, length:6}, vertical:true}); s.setState({selectedClipId:tx, playhead:s.getState().playhead+3}); await wait();
          out.push(document.body.textContent.includes('1 文字ずつ出す'));
          s.setState({project:keep, selectedClipId:null, playhead:0}); return [out, inScene]}""")
        check("グループ制御・カメラ・調整レイヤー・波形・シーン・1 文字ずつのプロパティが開ける", r[1] and r[0][5] is True and r[0][6] is True, str(r))
        # ── キー操作の割り当て（変えたキーで動き、元のキーは効かなくなる。同じキーはほかの操作から外す）
        r = await q.evaluate(r"""async()=>{const k=await import('/src/keymap.ts'); const s=await import('/src/store.ts');
          const ev=(key, code, o={})=>({key, code, ctrlKey:false, metaKey:false, altKey:false, shiftKey:false, ...o});
          const combos=[k.comboOf(ev('s','KeyS',{ctrlKey:true, shiftKey:true})), k.comboOf(ev('?','Slash',{shiftKey:true})), k.comboOf(ev(' ','Space')), k.comboOf(ev('Shift','ShiftLeft',{shiftKey:true}))];
          k.resetKeys(); const keep=structuredClone(s.getState().project); s.setState({project:{...keep, markers:[]}, playhead:5, selectedClipId:null, selectedClipIds:[]}); const before=0;
          const press=async(key, code)=>{document.body.dispatchEvent(new KeyboardEvent('keydown',{key, code, bubbles:true, cancelable:true})); await new Promise(r=>setTimeout(r,80))};
          const taken=k.assignKey('marker','J');
          await press('q','KeyQ'); const afterQ=s.getState().project.markers?.length ?? 0;
          await press('j','KeyJ'); const afterJ=s.getState().project.markers?.length ?? 0;
          await press('m','KeyM'); const afterM=s.getState().project.markers?.length ?? 0;
          const shuttle=k.keysFor('shuttleBackward'); const label=k.keyLabel('marker'); const stored=JSON.parse(localStorage.getItem('vx-keymap'));
          k.resetKeys(); s.setState({project:keep, playhead:0});
          return {combos, taken, n:[before, afterQ, afterJ, afterM], shuttle, label, stored, back:k.keysFor('shuttleBackward')}}""")
        check("キー操作：押したキーを Mod+Shift+S・?・Space の形で読む（修飾キーだけは読まない）", r['combos'] == ['Mod+Shift+S', '?', 'Space', None], str(r))
        check("キー操作：マーカーを J に変えると J で付き、元の M では付かない", r['n'][2] == r['n'][0] + 1 and r['n'][3] == r['n'][2], str(r))
        check("キー操作：J を使っていた逆再生からは外し、変えた分だけ覚える", r['taken'] == ['shuttleBackward'] and r['shuttle'] == [] and r['label'] == 'J' and r['stored']['marker'] == ['J'] and r['back'] == ['J'], str(r))
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({keymapOpen:true})}")
        await q.wait_for_timeout(400)
        await q.locator('[data-keymap-change="split"]').click(); await q.wait_for_timeout(100)
        await q.keyboard.press("Control+Shift+X"); await q.wait_for_timeout(200)
        r = await q.evaluate(r"""async()=>{const k=await import('/src/keymap.ts'); const t=document.querySelector('[data-keymap-keys="split"]')?.textContent; const ks=k.keysFor('split'); const cut=k.keysFor('cut'); k.resetKeys(); return {t, ks, cut, open:!!document.querySelector('dialog[open]')}}""")
        check("キー操作の割り当て画面：「変える」を押してからキーを押すと、そのキーになる", r['ks'] == ['Mod+Shift+X'] and 'X' in (r['t'] or '') and r['cut'] == ['Mod+X'] and r['open'], str(r))
        await q.keyboard.press("Escape"); await q.wait_for_timeout(300)
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({keymapOpen:false})}")
        # ── マイクの録音（16bit の WAV にする）・新しい音声合成ソフト・透明な書き出し
        r = await q.evaluate(r"""async()=>{const rec=await import('/src/record.ts'); const w=rec.encodeWav(new Float32Array([0, 1, -1, 0.5]), 48000); const d=new DataView(w.buffer);
          const tag=(o)=>String.fromCharCode(...w.slice(o,o+4)); const m=await import('/src/model.ts'); const ipc=await import('/src/ipc.ts'); const a=await ipc.api;
          const st=await a.engineStatus(); const p=await a.writeRecording(w);
          return {riff:tag(0), wave:tag(8), len:w.length, rate:d.getUint32(24,true), bits:d.getUint16(34,true), s1:d.getInt16(46,true), s2:d.getInt16(48,true), labels:['coeiroink','aquestalk','cevio'].map(e=>m.ENGINE_LABEL[e]), st:JSON.stringify(st), p}}""")
        check("録音：16bit モノラルの WAV（44 バイトの頭と、-1〜1 の音）", r['riff'] == 'RIFF' and r['wave'] == 'WAVE' and r['len'] == 52 and r['rate'] == 48000 and r['bits'] == 16 and r['s1'] == 32767 and r['s2'] <= -32767, str(r))
        check("音声合成ソフト：COEIROINK・ゆっくりボイス・CeVIO AI を選べる", r['labels'] == ['COEIROINK', 'ゆっくりボイス（AquesTalk）', 'CeVIO AI'] and all(f'"{e}"' in r['st'] for e in ['coeiroink', 'aquestalk', 'cevio']), str(r))
        await q.get_by_role("button", name="録音").first.click(); await q.wait_for_timeout(500)
        r = await q.evaluate("()=>({open:!!document.querySelector('dialog[open]'), t:document.querySelector('dialog[open]')?.textContent?.slice(0,200) ?? ''})")
        check("録音の画面が開く", r['open'] and '録音' in r['t'], str(r))
        await q.keyboard.press("Escape"); await q.wait_for_timeout(300)
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({settingsOpen:true})}"); await q.wait_for_timeout(500)
        r = await q.evaluate("()=>{const t=document.querySelector('dialog[open]')?.textContent ?? ''; return ['COEIROINK','ゆっくりボイス','CeVIO AI','AquesTalkPlayer'].map(x=>t.includes(x))}")
        check("設定：COEIROINK・ゆっくりボイス・CeVIO AI の欄がある", all(r), str(r))
        await q.evaluate("async()=>{const s=await import('/src/store.ts'); s.setState({settingsOpen:false})}"); await q.wait_for_timeout(300)
        await q.get_by_role("button", name="書き出す").first.click(); await q.wait_for_timeout(500)
        r = await q.evaluate("()=>{const t=document.querySelector('dialog[open]')?.textContent ?? ''; return [t.includes('背景'), t.includes('MP4（H.264')]}")
        check("書き出し：背景を選ぶ欄があり、はじめは MP4", all(r), str(r))
        await q.keyboard.press("Escape"); await q.wait_for_timeout(300)
        # ── 音のクロスフェード（core/src/model.rs の crossfades_extend_previous_sound と同じ数）・音のフェード
        r = await q.evaluate(r"""async()=>{const m=await import('/src/model.ts');
          const au=(id,start,duration,cf)=>({id, type:'media', trackId:'A1', start, duration, src:id+'.wav', mediaKind:'audio', hasAudio:true, inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}, ...(cf?{crossfade:cf}:{})});
          const p={tracks:[], clips:[au('a',0,30), au('b',31,60,40), au('c',200,30,10)]};
          const q=m.withTransitions(p); const g=id=>q.clips.find(c=>c.id===id);
          const f=au('x',0,30); f.soundFadeIn=10; f.soundFadeOut=6;
          return {same:m.withCrossfades({tracks:[], clips:[au('a',0,30), au('b',31,60)]}).clips[0].duration, a:[g('a').duration, g('a').soundFadeOut??0], b:g('b').soundFadeIn, c:[g('c').soundFadeIn??0, g('c').duration],
            fade:[m.soundFadeAt(f,0,1,30), m.soundFadeAt(f,1/6,1,30), m.soundFadeAt(f,0.5,1,30), m.soundFadeAt(f,0.9,1,30)]}}""")
        check("クロスフェード：前の音を 8 割まで延ばして消し、次の音は大きくする（書き出しと同じ数）", r['same'] == 30 and r['a'] == [55, 24] and r['b'] == 24 and r['c'] == [0, 30], str(r))
        check("音のフェード：頭から大きくなり、終わりで小さくなる（直線）", abs(r['fade'][0]) < 1e-9 and abs(r['fade'][1] - 0.5) < 1e-6 and r['fade'][2] == 1 and abs(r['fade'][3] - 0.5) < 1e-6, str(r))
        # ── 素材ライブラリ：入れる・同じものは増やさない・分類で絞る・押すと再生位置に置く・タイムラインへ落とすとそこに置く
        await q.evaluate("async()=>{const l=await import('/src/dock/layout.ts'); l.showPanel('library')}"); await q.wait_for_timeout(500)
        r = await q.evaluate(r"""async()=>{const ipc=await import('/src/ipc.ts'); const a=await ipc.api; const lp=await import('/src/panels/LibraryPanel.tsx'); const s=await import('/src/store.ts');
          const got=await a.libraryAdd(['/m/ポン.wav','/m/bg.png','/m/memo.txt'], '効果音', null); await a.libraryAdd(['/m/ポン.wav'], '', null); lp.libraryChanged();
          await new Promise(r=>setTimeout(r,400));
          const rows=[...document.querySelectorAll('[data-library-item]')].map(e=>e.textContent);
          const keep=structuredClone(s.getState().project); s.setState({playhead:12});
          const n0=s.getState().project.clips.length;
          [...document.querySelectorAll('[data-library-item]')].find(e=>e.textContent.includes('ポン')).querySelector('button:nth-last-of-type(2)').click();
          await new Promise(r=>setTimeout(r,400));
          const added=s.getState().project.clips.slice(n0); const placed=added.map(c=>[c.src, c.start]);
          s.setState({project:keep, playhead:0});
          return {kinds:got.map(i=>i.kind), n:(await a.libraryList()).length, rows, placed}}""")
        check("ライブラリ：画像・音声だけ入れ、同じものは増やさない", r['kinds'] == ['audio', 'image'] and r['n'] == 2 and len(r['rows']) == 2, str(r))
        check("ライブラリ：「置く」で再生位置に置く", r['placed'] == [['/m/ポン.wav', 12]], str(r))
        await q.evaluate("async()=>{const l=await import('/src/dock/layout.ts'); l.showPanel('timeline')}"); await q.wait_for_timeout(300)
        await q.evaluate("async()=>{const l=await import('/src/dock/layout.ts'); l.showPanel('library')}"); await q.wait_for_timeout(400)
        item = q.locator('[data-library-item]', has_text="bg").first
        tl = q.locator('.vx-timeline-scroll').first
        ib = await item.bounding_box(); tb = await tl.bounding_box()
        n0 = await q.evaluate("async()=>{const s=await import('/src/store.ts'); window.__keepP=structuredClone(s.getState().project); return s.getState().project.clips.length}")
        await q.mouse.move(ib['x'] + 20, ib['y'] + ib['height'] / 2); await q.mouse.down()
        tx, ty = tb['x'] + tb['width'] * 0.6, tb['y'] + 40
        await q.mouse.move(tx, ty, steps=8)
        hit0 = await q.evaluate("async([x,y])=>{const t=await import('/src/timeline/Timeline.tsx'); return [t.timelineHit.current(x,y), document.querySelector('.vx-library-ghost')?.dataset.over]}", [tx, ty])
        await q.mouse.up(); await q.wait_for_timeout(500)
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const t=await import('/src/timeline/Timeline.tsx'); const st=s.getState();
          const added=st.project.clips.slice(%d); const out={added:added.map(c=>[c.src, c.start, c.trackId]), ghost:!!document.querySelector('.vx-library-ghost'), busy:window.__keepP.clips.filter(c=>added[0] && c.start < added[0].start+added[0].duration && c.start+c.duration > added[0].start).map(c=>c.trackId)};
          s.setState({project:window.__keepP}); return out}""" % n0)
        r['hit'], r['over'] = hit0
        check("ライブラリ：タイムラインへドラッグすると、落とした所のフレーム・レイヤーに置く（ふさがっていれば空いたレイヤー）", len(r['added']) == 1 and r['added'][0][0] == '/m/bg.png' and abs(r['added'][0][1] - round(r['hit']['frame'])) <= 1 and (r['added'][0][2] == r['hit']['trackId'] or r['hit']['trackId'] in r['busy']) and r['over'] == '1' and not r['ghost'], str(r))
        # ── まとめて書き出し：予約に足す・マーカーで分けて予約・順番に書き出す
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const keep=structuredClone(s.getState().project); window.__keepP=keep;
          s.setState({project:{...keep, markers:[{id:'mk1', frame:30, name:'a'},{id:'mk2', frame:60, name:'b'}]}, exportQueue:[]}); return true}""")
        await q.get_by_role("button", name="書き出す").first.click(); await q.wait_for_timeout(500)
        await q.get_by_role("button", name="予約に足す…").click(); await q.wait_for_timeout(300)
        await q.get_by_role("button", name=re.compile("マーカーで .* 本に分けて予約")).click(); await q.wait_for_timeout(300)
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); return {q:s.getState().exportQueue.map(j=>[j.out, j.options.rangeFrames ?? null]), list:document.querySelector('[data-export-queue]')?.textContent ?? ''}}""")
        check("まとめて書き出し：予約に足し、マーカーで区切って _01・_02… に分ける", len(r['q']) == 4 and r['q'][0][1] is None and [x[1] for x in r['q'][1:]][:2] == [[0, 30], [30, 60]] and r['q'][1][0].endswith('_01.mp4') and '予約（4 件）' in r['list'], str(r))
        await q.get_by_role("button", name=re.compile("予約した 4 件を順番に書き出す")).click()
        await q.wait_for_selector('[data-export-results]', timeout=30000); await q.wait_for_timeout(300)
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const t=document.querySelector('[data-export-results]').textContent; const left=s.getState().exportQueue.length; s.setState({project:window.__keepP, exportQueue:[]}); return {t, left, banner:document.querySelector('dialog[open]').textContent.includes('4 件を書き出しました')}}""")
        check("まとめて書き出し：順番に全部書き出し、書き出したものは予約から外す", r['banner'] and r['left'] == 0 and r['t'].count('書き出し済み') == 4, str(r))
        await q.keyboard.press("Escape"); await q.wait_for_timeout(300)
        # ── 立ち絵の呼吸（Rust の Breath::scale_at と同じ）・タイマー（Rust の Timer::text_at と同じ数）
        r = await q.evaluate(r"""async()=>{const m=await import('/src/model.ts'); const v=await import('/src/preview/visual.ts'); const b={amount:20, period:2};
          const d={from:10, to:0, format:'s'}, u={from:55, to:3700, format:'m:ss'}, h={from:3599, to:4000, format:'h:mm:ss'}, c={from:5, to:0, format:'m:ss.cc'};
          const tx={id:'tm', type:'text', trackId:'V1', start:0, duration:90, text:'残り {t}', fontFamily:'sans-serif', fontSize:40, color:'#fff', outlineColor:'#000', outlineWidth:0, bold:false, italic:false, align:'center', transform:{x:0,y:0,scale:1,opacity:1}, timer:d};
          const p={video:{width:320, height:180, fps:30, background:'#000', sampleRate:48000}, tracks:[], characters:[], clips:[tx]};
          const baked=await v.bakeItemImages(p);
          return {b:[m.breathScale(b,0), m.breathScale(b,0.5), m.breathScale(b,1), m.breathScale(null,1)],
            d:[0,1,29,30,299,300,400].map(f=>m.timerText(d,'',f,30)), u:[0,150,3600].map(f=>m.timerText(u,'残り {t}',f,30)), h:m.timerText(h,'',30,30), c:[0,1,15].map(f=>m.timerText(c,'',f,30)),
            step:[m.timerStep(c,30), m.timerStep(d,30)], baked:Object.keys(baked).sort(), w:[v.itemImage(tx,0,30).width > v.itemImage({...tx, timer:{...d, from:1}},0,30).width]}}""")
        check("立ち絵の呼吸：1 から 1.2 倍までなめらかに（書き出しと同じ式）", [round(x, 6) for x in r['b']] == [1, 1.1, 1.2, 1], str(r))
        check("タイマー：カウントダウン・カウントアップ・表し方（書き出しと同じ数）", r['d'] == ['10', '10', '10', '9', '1', '0', '0'] and r['u'] == ['残り 0:55', '残り 1:00', '残り 2:55'] and r['h'] == '1:00:00' and r['c'] == ['0:05.00', '0:04.97', '0:04.50'] and r['step'] == [1, 30], str(r))
        check("タイマー：書き出しは 1 秒ごとの画像（id#1〜）を渡し、プレビューは数字で幅が変わる", r['baked'] == ['tm#1', 'tm#2', 'tm#3'] and r['w'] == [True], str(r))
        # ── 自動バックアップ：上書き保存の前の内容を残し、一覧から開ける（保存先は元のまま）
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const a=await import('/src/actions.ts'); const ipc=await import('/src/ipc.ts'); const api=await ipc.api;
          const keep=structuredClone(s.getState().project); const keepPath=s.getState().projectPath; const notify=()=>{};
          s.setState({projectPath:'/p/作品.voxcut', project:{...keep, name:'一回目'}, dirty:true}); await a.saveProject(notify);
          s.setState({project:{...keep, name:'二回目'}, dirty:true}); await a.saveProject(notify);
          s.setState({project:{...keep, name:'三回目'}, dirty:true}); await a.saveProject(notify);
          const list=await api.listBackups('/p/作品.voxcut');
          s.setState({backupOpen:true}); await new Promise(r=>setTimeout(r,500));
          const rows=document.querySelectorAll('[data-backups] button').length;
          document.querySelectorAll('[data-backups] button')[1].click(); await new Promise(r=>setTimeout(r,500));
          const st=s.getState(); const out={n:list.length, rows, name:st.project.name, path:st.projectPath, dirty:st.dirty, open:st.backupOpen};
          s.setState({project:keep, projectPath:keepPath, dirty:false}); return out}""")
        check("自動バックアップ：上書きする前の内容を新しい順に残す", r['n'] == 2 and r['rows'] == 2, str(r))
        check("自動バックアップ：古い版を開くと、保存先は元のファイルのまま・未保存になる", r['name'] == '一回目' and r['path'] == '/p/作品.voxcut' and r['dirty'] and not r['open'], str(r))
        # ── 画面録画：画面が開き、録ったものを保存して置ける
        await q.get_by_role("button", name="画面録画").first.click(); await q.wait_for_timeout(400)
        r = await q.evaluate(r"""async()=>{const c=await import('/src/capture.ts'); const t=document.querySelector('dialog[open]')?.textContent ?? '';
          return {open:t.includes('画面を録画') && t.includes('パソコンの音も録る'), mime:c.captureMime(), status:!!document.querySelector('[data-capture-status]')}}""")
        check("画面録画：画面が開き、WebM で録れる", r['open'] and r['status'] and r['mime'].startswith('video/webm'), str(r))
        await q.keyboard.press("Escape"); await q.wait_for_timeout(300)
        # ── 動く図形：粒（4 秒でつなぎ目なくくり返す）・進行バー・グラフ（書き出しの ShapeAnim::sequence と同じ並べ方）
        r = await q.evaluate(r"""async()=>{const an=await import('/src/preview/anim.ts'); const v=await import('/src/preview/visual.ts');
          const sh=(id,w,h,dur,anim)=>({id, type:'shape', trackId:'V1', start:0, duration:dur, shape:'rect', width:w, height:h, fill:'#f00', stroke:'', strokeWidth:0, transform:{x:0,y:0,scale:1,opacity:1}, anim});
          const pt=sh('pt',160,90,300,{kind:'particles', type:'confetti', amount:40, speed:2, size:12, colors:['#f00','#0f0']});
          const pg=sh('pg',100,10,1000,{kind:'progress', trackColor:'#333', chapters:true, labels:false});
          const ch=sh('ch',200,120,150,{kind:'chart', chart:'bar', items:[{label:'A',value:3,color:'#f00'},{label:'B',value:5,color:'#0f0'}], grow:30, showValues:true, unit:'', textColor:'#fff'});
          const px=c=>Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data);
          const same=(a,b)=>{const x=px(a), y=px(b); let d=0; for(let i=0;i<x.length;i++) d=Math.max(d,Math.abs(x[i]-y[i])); return d};
          const p={video:{width:320,height:180,fps:30,background:'#000',sampleRate:48000}, tracks:[], characters:[], clips:[pt,pg,ch], markers:[{id:'m',frame:500,name:'後半'}]};
          const baked=await v.bakeItemImages(p); const count=id=>Object.keys(baked).filter(k=>k.startsWith(id+'#')).length;
          // 進行バー：真ん中のマーカーの所にすき間、半分で半分まで伸びる
          const bar=an.animImage(pg, 500, 30, p.markers); const d=bar.getContext('2d').getImageData(0,5,100,1).data; const alpha=i=>d[i*4+3]; const red=i=>d[i*4]>200&&d[i*4+1]<50;
          const chart0=px(an.animImage(ch,0,30)).filter((x,i)=>i%4===3&&x>0).length, chart1=px(an.animImage(ch,30,30)).filter((x,i)=>i%4===3&&x>0).length;
          return {loop:an.particleLoop(30), seam:same(an.animImage(pt,0,30,[],false), an.animImage(pt,120,30,[],false)), moves:same(an.animImage(pt,0,30,[],false), an.animImage(pt,30,30,[],false)),
            step:[an.animStep(pg.anim,100,1000), an.animStep(pt.anim,160,300), an.animStep(ch.anim,200,150)], at:[an.animFrameAt(pt,121,30), an.animFrameAt(pg,519,30), an.animFrameAt(ch,99,30)],
            counts:[count('pt'), count('pg'), count('ch')], gap:[alpha(49), alpha(50), alpha(51)].some(a=>a===0), half:[red(30), red(70)], grow:[chart0, chart1]}}""")
        check("粒：4 秒でつなぎ目なく元に戻り、その間は動く", r['loop'] == 120 and r['seam'] <= 2 and r['moves'] > 50, str(r))
        check("動く図形：書き出しの並べ方と同じ（進行バーは幅ぶん、粒はくり返し、グラフは伸びきったら止まる）", r['step'] == [{'step': 10, 'loop': False}, {'step': 1, 'loop': True}, {'step': 1, 'loop': False}] and r['at'] == [1, 510, 30] and r['counts'] == [120, 100, 31], str(r))
        check("進行バー：マーカーの所で区切り、半分で半分まで伸びる。グラフは伸びていく", r['gap'] and r['half'] == [True, False] and r['grow'][0] < r['grow'][1], str(r))
        # ── 画面分割：2 つの動画を左右に（はみ出す分は真ん中を残して切り抜く）・小窓
        r = await q.evaluate(r"""async()=>{const sp=await import('/src/split.ts');
          const lr=sp.splitPlacement('lr', [[1920,1080],[1920,1080]], {width:1920,height:1080}, 0);
          const pip=sp.splitPlacement('pip', [[1920,1080],[1920,1080]], {width:1920,height:1080}, 0);
          const g4=sp.splitPlacement('grid4', [[1080,1080],[1080,1080],[1080,1080],[1080,1080]], {width:1920,height:1080}, 20);
          return {lr, pip, g4:g4.map(x=>[x.transform.x, x.transform.y, x.transform.scale, x.crop]), n:[2,3,4].map(n=>sp.layoutsFor(n))}}""")
        lr = r['lr']
        check("画面分割：左右は半分ずつ。真ん中を残して左右を 4 分の 1 ずつ切る", lr[0]['transform'] == {'x': -480, 'y': 0, 'scale': 1} and lr[1]['transform']['x'] == 480 and lr[0]['crop'] == {'left': 0.25, 'right': 0.25, 'top': 0, 'bottom': 0}, str(r))
        check("画面分割：小窓は切り抜かずに右下へ、4 分割はすき間を空ける", r['pip'][1]['crop'] is None and r['pip'][1]['transform']['x'] > 0 and r['pip'][1]['transform']['y'] > 0 and abs(r['g4'][0][0] - (-475)) < 1 and r['n'] == [['lr', 'tb', 'pip'], ['l1r2', 't1b2', 'row3'], ['grid4']], str(r))
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const keep=structuredClone(s.getState().project); window.__keepP=keep;
          const m=(id,src)=>({id, type:'media', trackId:id==='a'?'V1':'V2', start:0, duration:90, src, mediaKind:'video', hasAudio:false, inPoint:0, volume:1, transform:{x:0,y:0,scale:1,opacity:1}});
          s.setState({project:{...keep, clips:[...keep.clips, m('a','/v/a.mp4'), m('b','/v/b.mp4')]}, media:{...s.getState().media, '/v/a.mp4':{kind:'video',hasAudio:false,durationMs:3000,width:1920,height:1080}, '/v/b.mp4':{kind:'video',hasAudio:false,durationMs:3000,width:1920,height:1080}}, selectedClipIds:['a','b'], selectedClipId:'a', splitOpen:true}); return true}""")
        await q.wait_for_timeout(400)
        await q.locator('[data-layout="tb"]').click(); await q.wait_for_timeout(100)
        await q.get_by_role("button", name="並べる").click(); await q.wait_for_timeout(300)
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const st=s.getState(); const g=id=>st.project.clips.find(c=>c.id===id); const vh=st.project.video.height;
          const out={a:[g('a').transform.y, g('a').crop], b:g('b').transform.y, vh, open:st.splitOpen}; s.setState({project:window.__keepP, selectedClipIds:[], selectedClipId:null}); return out}""")
        check("画面分割：ダイアログで「上下」を選んで並べると、上と下に収まる（すき間 8px）", abs(r['a'][0] + r['vh'] / 4) <= 8 and r['b'] == -r['a'][0] and r['a'][1] is not None and not r['open'], str(r))
        # ── 吹き出し・集中線・まとめたテンプレート
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const v=await import('/src/preview/visual.ts'); const an=await import('/src/preview/anim.ts'); const keep=structuredClone(s.getState().project); window.__keepP=keep;
          const id=s.addBubble('round'); const c=s.getState().project.clips.find(x=>x.id===id);
          const plain=v.textImage({...c, bubble:null}); const b1=v.textImage(c); const b2=v.textImage({...c, bubble:{...c.bubble, tailAngle:(c.bubble.tailAngle+180)%360}});
          const px=x=>Array.from(x.getContext('2d').getImageData(0,0,x.width,x.height).data); const diff=(a,b)=>{if(a.width!==b.width||a.height!==b.height) return 999; const x=px(a),y=px(b); let d=0; for(let i=0;i<x.length;i++) d=Math.max(d,Math.abs(x[i]-y[i])); return d};
          const shout=v.textImage({...c, bubble:{...c.bubble, kind:'shout'}});
          const lid=s.addEffectLines('focus'); const l=s.getState().project.clips.find(x=>x.id===lid); const fps=s.getState().project.video.fps;
          const still={...l, anim:{...l.anim, flicker:false}};
          const ink=x=>px(x).filter((a,i)=>i%4===3&&a>0).length;
          const out={size:[plain.width,plain.height,b1.width,b1.height], tail:diff(b1,b2), shout:diff(b1,shout), lines:[an.animFrames(l,fps).length, an.animFrames(still,fps).length, an.animStep(l.anim,l.duration,l.duration).loop, an.animFrameAt(l,20,fps)],
            ink:['focus','speed','shock','anger'].map(t=>ink(an.animImage({...l, anim:{...l.anim, type:t}},0,fps))), flick:diff(an.animImage(l,0,fps,[],false), an.animImage(l,4,fps,[],false))};
          s.setState({project:keep}); return out}""")
        sz = r['size']
        check("吹き出し：文字より大きい枠になり、しっぽの向き・形で絵が変わる", sz[2] > sz[0] and sz[3] > sz[1] and r['tail'] > 50 and r['shout'] > 50, str(r))
        check("集中線：ちらつかせると 16 枚でくり返し、止めると 1 枚。4 種類とも描ける", r['lines'] == [16, 1, True, 4] and all(n > 100 for n in r['ink']) and r['flick'] > 50, str(r))
        r = await q.evaluate(r"""async()=>{const s=await import('/src/store.ts'); const t=await import('/src/templates.ts'); const keep=structuredClone(s.getState().project); window.__keepP=keep;
          const p=s.getState().project; const L=p.tracks.map(x=>x.id);
          const txt={id:'g1', type:'text', trackId:L[L.length-1], start:100, duration:60, text:'タイトル', fontSize:80, color:'#fff', outlineColor:'#000', outlineWidth:4, align:'center', transform:{x:0,y:0,scale:1,opacity:1}};
          const shp={id:'g2', type:'shape', trackId:L[L.length-2], start:110, duration:40, shape:'rect', fill:'#f00', width:200, height:100, transform:{x:0,y:0,scale:1,opacity:1}};
          s.setState({project:{...p, clips:[...p.clips, txt, shp]}});
          const items=t.toGroup(s.getState().project, ['g1','g2']);
          const saved=t.saveTemplate('group', t.groupTemplateName(items), items);
          const back=t.getTemplates().find(x=>x.id===saved.id);
          s.setState({project:keep, playhead:300});
          const n=s.insertGroupTemplate(back.data); const st=s.getState().project; const ids=s.getState().selectedClipIds;
          const put=ids.map(id=>st.clips.find(c=>c.id===id)); const ti=st.tracks.map(x=>x.id);
          const a=put.find(c=>c.type==='text'), b=put.find(c=>c.type==='shape');
          const out={n, name:saved.name, layers:items.map(i=>i.layer), start:[a.start,b.start], above:ti.indexOf(a.trackId)>ti.indexOf(b.trackId), fresh:!keep.clips.some(c=>c.id===a.id)};
          t.removeTemplate(saved.id); s.setState({project:keep, selectedClipIds:[], selectedClipId:null}); return out}""")
        check("まとめたテンプレート：2 つを保存して再生位置に置くと、ずれと上下の並びを保つ", r['n'] == 2 and r['start'] == [300, 310] and r['above'] and r['fresh'] and r['name'].startswith('タイトル'), str(r))
        check("この区切りの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        check("画面のエラーが出ていない", not pg.errs, str(pg.errs[:3]))
        await b.close()
    print(f"\n{'すべて通りました' if not fails else str(len(fails)) + ' 件 NG'}")
    sys.exit(1 if fails else 0)

asyncio.run(main())
