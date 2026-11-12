# VoxCut

A.I.VOICE / VOICEPEAK / VoiSona Talk / VOICEVOX と連携する、軽量な動画編集ソフト（Windows 向け、Tauri 2 ＋ React ＋ Astryx）。
設計は [ARCHITECTURE.md](ARCHITECTURE.md) を参照。

## 開発に必要なもの（Windows）

- Rust（stable, MSVC）、Node.js 20 以上、.NET SDK 8 以上、PowerShell 7（pwsh）
- WebView2（Windows 11 は標準搭載）

## 動かす（Windows）

```powershell
npm install            # ルートで実行。app/ の依存も入る
npm run sidecars       # 同梱する FFmpeg と A.I.VOICE 補助プロセスを用意（初回だけ。.NET SDK 8 以上が必要）
npm run dev            # 開発起動（Vite + Tauri）
npm test               # Rust コアのテスト ＋ 型チェック ＋ 口パク計算の一致確認
```

デザインだけ確認したいときは `npm --prefix app run dev` でブラウザから開ける（音声合成は模擬動作になる）。

## インストーラーを作る

### GitHub で自動で作る（おすすめ）

このフォルダを GitHub のリポジトリにして push すると、`.github/workflows/windows.yml` が Windows 上で
テスト → 同梱物の用意 → インストーラー作成 まで行う。できたインストーラーは Actions の実行結果の「Artifacts」（VoxCut-setup）からダウンロードできる。
`v0.1.0` のようなタグを push すると、GitHub Releases に下書きとしても置かれる。

### 手元の Windows で作る

```powershell
npm run build:windows  # = scripts/build-windows.ps1
```

`target/release/bundle/nsis/VoxCut_0.1.0_x64-setup.exe` ができる。

### インストーラーの中身

| 項目 | 内容 |
|---|---|
| 入れる場所 | `%LOCALAPPDATA%\Programs\VoxCut`（管理者権限は不要） |
| 同梱物 | VoxCut 本体、ffmpeg.exe / ffprobe.exe（GPL ビルド）、aivoice-bridge.exe、THIRD_PARTY_NOTICES.md |
| WebView2 | 無い PC では、インストール中に Microsoft のインストーラーを取得して入れる |
| 言語 | 日本語 |

FFmpeg を同梱するため、インストーラーはおよそ 80〜100MB になる見込み。ライセンスは `THIRD_PARTY_NOTICES.md` を参照。

### A.I.VOICE 補助プロセス

`bridges/aivoice-bridge` は .NET Framework 4.8 の単一 exe（追加 DLL なし）。
`AI.Talk.Editor.Api.dll` はビルド時にも参照せず、実行時に A.I.VOICE のインストール先から読み込む（`AIVOICE_DIR` で場所を変えられる）。
`bridges/aivoice-bridge/test/run-test.ps1` で、偽の API を使った動作確認ができる（CI でも実行）。

### 立ち絵

キャラクターを選んで右パネルの「立ち絵」から、体・目（開/半目/閉）・口（閉/半開き/開）の透過 PNG を選ぶ。すべて同じキャンバスサイズで作ること。
`app/public/sample/` に動作確認用のオリジナル立ち絵（自由に使ってよい）が入っている。

### 動画素材と字幕アニメーション

- 動画を追加すると、プレビュー用の軽い動画（プロキシ）を自動で作る。作っている間はタイムラインと右パネルに進み具合が出る
- 字幕の出し方（なし／フェード／ポップ／1文字ずつ）はキャラクターごとに右パネルの「字幕」で選ぶ
- Linux の WebKitGTK では、止めた状態でシークしても動画の絵が更新されないことがある（Windows の WebView2 では正しく出ることを Chromium で確認済み）

### 操作（一般的な動画編集ソフトと同じ）

| 操作 | 動き |
|---|---|
| Space / K | 再生・停止 |
| L / J | 再生 / 逆再生（押すたびに 1→2→4 倍。逆再生は音なし） |
| ← → | 1 コマ戻る・進む（Shift で 1 秒） |
| ↑ ↓ | 前・次の編集点（クリップの切れ目）へ |
| Home / End | 先頭・末尾へ |
| プレビューをダブルクリック | 全画面（Esc で戻る） |
| Ctrl+← → / Ctrl+↑ ↓ | タイムラインで前後のクリップ / 上下のトラックのクリップを選ぶ |
| Alt+← → か , . | 選んだクリップを 1 コマ動かす（Shift で 1 秒） |
| クリップ中央・端をドラッグ | 移動・長さ調整（ほかの端・再生位置にスナップ。Alt で無効） |
| S | 選んだ素材を再生位置で分ける |
| Delete | 選んだクリップを消す |
| Ctrl+Z / Ctrl+Y | 元に戻す / やり直す |
| Ctrl+L | セリフ入力欄へ |
| Ctrl+ホイール | タイムラインの拡大縮小 |

プレビューの下の操作バーで、表示倍率（全体・25〜200%）、プレビュー画質（フル・1/2・1/4。書き出しには影響しない）、セーフエリア、ループ再生、全画面を切り替えられる。

### テーマを変えたとき

`app/src/themes/voxcut/voxcutTheme.ts` を編集したら `npm --prefix app run theme:build` で CSS を作り直す。

## フォルダ

| 場所 | 中身 |
|---|---|
| `core/` | Rust のコア（モデル・3エンジン連携・キャッシュ・波形・字幕・FFmpeg）。Tauri に依存しない |
| `src-tauri/` | Tauri の IPC コマンド |
| `bridges/aivoice-bridge/` | A.I.VOICE 用の C# 補助プロセス |
| `app/` | 画面（React 19 + Astryx、HIG 寄せのテーマ） |

## 実機で確認が必要な点

- **VoiSona Talk**：エンドポイント名と JSON のフィールド名（`core/src/tts/voisona.rs` の `api` モジュール）を、アプリ内の Talk API Reference と照合する
- **A.I.VOICE**：プリセット一覧のプロパティ名（`VoicePresetNames`）。A.I.VOICE2 で同じ API が使えるか
- **VOICEPEAK**：`--speed` / `--pitch` / `-e` の値の範囲。多重起動できないので直列で呼んでいる
