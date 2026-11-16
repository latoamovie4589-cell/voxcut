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

        check("画面のエラーが出ていない", not pg.errs, str(pg.errs[:3]))
        await b.close()
    print(f"\n{'すべて通りました' if not fails else str(len(fails)) + ' 件 NG'}")
    sys.exit(1 if fails else 0)

asyncio.run(main())
