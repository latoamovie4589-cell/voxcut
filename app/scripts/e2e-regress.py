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
        # ── お手本の動画の編集：クリッピング解除・言葉の色・字幕のグラデーション
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
          const draw=(ch, f, hl, txt='WWWW')=>{const c=document.createElement('canvas'); c.width=p.video.width/2; c.height=p.video.height/2; const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,c.width,c.height);
            pv.drawSubtitle(x, txt, ch, p, 0.5, f, 60, hl); const d=x.getImageData(0,0,c.width,c.height).data; const cols=[];
            for (let X=0; X<c.width; X++) { for (let Y=0; Y<c.height; Y++) { const i=(Y*c.width+X)*4; if (d[i]+d[i+1]+d[i+2]>300) { cols.push([X, d[i+1]<120]); break; } } } return cols};
          const [x1,x2,ms]=sa.wipeBounds('WWWW', 120, p.video.width, 60, 30);
          const mid=draw(mk({animation:'wipe'}), 7.5, null); const done=draw(mk({animation:'wipe'}), 30, null);
          const cut=(x1+(x2-x1)*(250/ms))*0.5;
          const hl=draw(mk({animation:'none'}), 10, [{word:'HHH', color:'#FF0000'}], 'HHHH');
          const red=hl.filter(c=>c[1]).map(c=>c[0]); const white=hl.filter(c=>!c[1]).map(c=>c[0]);
          return [sa.wipeBounds('あいう', 56, 1920, 90, 30), mid.length>0 && mid.every(c=>c[0]<cut+2), mid.length < done.length*3/4, (()=>{const xs=hl.map(c=>c[0]); const lo=Math.min(...xs), hi=Math.max(...xs); const L=hl.filter(c=>c[0]<lo+(hi-lo)*0.65), R=hl.filter(c=>c[0]>lo+(hi-lo)*0.8); return [L.filter(c=>c[1]).length, L.length, R.filter(c=>!c[1]).length, R.length, lo, hi]})()]}""")
        check("クリッピング解除（字幕）：書き出しと同じ範囲・速さで左から現れる", r[0] == [859, 1061, 500] and r[1] and r[2], str(r))
        check("言葉の色：字幕の中の言葉だけ色が変わる", r[3][0] > r[3][1]*0.8 and r[3][2] > r[3][3]*0.8, str(r))
        r = await q.evaluate(r"""async()=>{const v=await import('/src/preview/visual.ts'); const m=await import('/src/model.ts');
          const vc={id:'v', trackId:'V1', start:0, duration:30, type:'voice', characterId:'x', text:'カニ', subtitle:null};
          const sc={fontFamily:'sans-serif', fontSize:80, color:'#FFFF00', outlineColor:'#000000', outlineWidth:0, bold:true, italic:false, align:'center', transform:{x:0,y:0,scale:1,opacity:1}, gradientColor:'#FF0000'};
          const c=v.subtitleImage(vc, sc); const x=c.getContext('2d'); const d=x.getImageData(0,0,c.width,c.height).data;
          let top=null, bot=null; for (let Y=0; Y<c.height; Y++) for (let X=0; X<c.width; X++) { const i=(Y*c.width+X)*4; if (d[i+3]>250) { if (!top) top=[d[i],d[i+1]]; bot=[d[i],d[i+1]]; } }
          return [m.highlightMask('今日はカ\nニ漁', [{word:'カニ', color:'#F00'}, {word:'漁', color:'#00F'}]), top, bot]}""")
        check("言葉の色：書き出しと同じ文字に色が付く", r[0] == [None, None, None, '#F00', '#F00', '#00F'], str(r))
        check("個別に設定した字幕：グラデーション（上は黄色、下は赤）", r[1] is not None and r[1][1] > 150 and r[2][1] < r[1][1] - 60, str(r))
        check("この区切りの画面でエラーが出ていない", not q.errs, str(q.errs[:3]))
        await q.close()

        check("画面のエラーが出ていない", not pg.errs, str(pg.errs[:3]))
        await b.close()
    print(f"\n{'すべて通りました' if not fails else str(len(fails)) + ' 件 NG'}")
    sys.exit(1 if fails else 0)

asyncio.run(main())
