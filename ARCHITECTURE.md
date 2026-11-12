# VoxCut 設計書

合成音声ソフトと連携する動画編集ソフト。YMM4 と同じく「セリフを書く → 音声を自動生成 → 字幕と音声がタイムラインに並ぶ → 書き出す」流れを、軽量なデスクトップアプリで実現する。

- 対象 OS：Windows 10/11（主）。VOICEPEAK・VoiSona Talk だけなら macOS でも動く構成にしておく
- 対応エンジン：A.I.VOICE / VOICEPEAK / VoiSona Talk / VOICEVOX（exe の場所は設定画面でユーザーが選ぶ）
- デザイン：Astryx（React＋StyleX）に HIG 寄りのテーマを当てる。Liquid Glass は使わない（不透明な面のみ）

---

## 1. プロセス構成

```
┌──────────────────────────── VoxCut.exe（Tauri 2） ────────────────────────────┐
│  WebView2（UI）                         Rust（src-tauri ＋ voxcut-core）        │
│  React 19 + Astryx                      ・プロジェクト読み書き                 │
│  ・タイムライン（Canvas 描画）  ◀─IPC─▶  ・音声合成ジョブ（エンジン別キュー）   │
│  ・プレビュー（Canvas＋WebAudio）        ・WAV キャッシュ / 波形ピーク計算       │
│  ・インスペクタ（Astryx 部品）           ・FFmpeg で書き出し（進捗イベント）     │
└──────────────────────────────────────────────┬────────────────────────────────┘
          │HTTP(localhost:32766)        │子プロセス(CLI)        │stdin/stdout JSON Lines
          ▼                             ▼                       ▼
   VoiSona Talk（REST API）      voicepeak.exe            aivoice-bridge.exe（C# / .NET Framework 4.8）
                                                                 │ AI.Talk.Editor.Api.dll
                                                                 ▼
                                                          A.I.VOICE Editor
```

| 層 | 技術 | 担当 |
|---|---|---|
| UI | TypeScript, React 19, Astryx 0.7 | 表示と操作だけ。重い計算はしない |
| シェル | Rust, Tauri 2 | コマンド受付、イベント送出、ファイルダイアログ |
| コア | Rust（`voxcut-core`、Tauri 非依存） | モデル、エンジン連携、キャッシュ、波形、字幕、FFmpeg 引数生成 |
| 補助 | C#（`aivoice-bridge`） | A.I.VOICE の .NET API を JSON Lines で中継。常駐させて起動コストを1回にする |
| 書き出し | FFmpeg（同梱） | 合成・エンコード |

コアを Tauri から切り離しているのは、単体テストを UI なしで回せるようにするため。

---

## 2. 軽さ・速さのための決めごと

1. **UI は描くだけ**：合成・波形計算・書き出しは Rust。IPC は小さな JSON と、波形は `Vec<i8>` のピーク列だけを渡す（WAV 本体は渡さない）。
2. **音声キャッシュ**：`sha256(エンジン | 話者 | パラメータ(正規化JSON) | 本文)` をキーに `cache/ab/abcdef….wav` へ保存。本文や声を変えた行だけ再合成。
3. **エンジン別キュー**：A.I.VOICE・VOICEPEAK は同時に1件しか処理できないので直列。エンジン同士は並列に動かす。
4. **タイムラインは Canvas 1 枚**：クリップを DOM 要素にしない。表示範囲のクリップだけ描く。スクロール・ズームは `requestAnimationFrame` で間引く。
5. **プレビューは軽い経路**：字幕・画像は Canvas 2D、音声は WebAudio。動画素材は将来プロキシ（低解像度コピー）を作って再生する。最終画質は書き出し時に FFmpeg が元素材から作る。
6. **テーマはビルド済み CSS**：`astryx theme build` で CSS にしてから読み込む（実行時に style を注入しない）。コンポーネントは個別パスから import。
7. **時間は整数フレーム**：浮動小数の誤差でクリップがずれないよう、位置と長さはフレーム数で持つ。

---

## 3. プロジェクトファイル（`*.voxcut`、JSON）

```jsonc
{
  "version": 1,
  "name": "サンプル動画",
  "video": { "width": 1920, "height": 1080, "fps": 30, "sampleRate": 48000, "background": "#000000" },
  "characters": [
    {
      "id": "ch_a",
      "name": "ナレーター",
      "color": "#0A84FF",                       // タイムライン上の色
      "voice": {
        "engine": "voicepeak",                  // "aivoice" | "voicepeak" | "voisona"
        "speaker": "Japanese Female 1",         // エンジン側の話者 / プリセット名
        "params": { "speed": 1.0, "pitch": 0.0, "volume": 1.0, "intonation": 1.0,
                    "emotions": { "happy": 30 } }  // エンジン固有（VOICEPEAK の感情など）
      },
      "subtitle": { "fontFamily": "Hiragino Sans", "fontSize": 56, "color": "#FFFFFF",
                    "outlineColor": "#000000", "outlineWidth": 4, "position": "bottom", "marginV": 60 }
    }
  ],
  "tracks": [
    { "id": "t_voice", "kind": "voice", "name": "セリフ", "muted": false, "locked": false },
    { "id": "t_media", "kind": "media", "name": "素材",   "muted": false, "locked": false }
  ],
  "clips": [
    {
      "id": "c1", "trackId": "t_voice", "start": 0, "duration": 75,
      "type": "voice",
      "characterId": "ch_a",
      "text": "こんにちは、VoxCutです。",
      "subtitle": null,                          // null なら text をそのまま字幕に
      "paramsOverride": null,                    // この行だけ声を変える場合
      "audio": { "cacheKey": "9f2c…", "durationMs": 2410 },  // 合成済みなら入る
      "gapAfter": 6                              // 次のセリフまでの間（フレーム）
    },
    {
      "id": "c2", "trackId": "t_media", "start": 0, "duration": 300,
      "type": "media",
      "src": "assets/bg.png", "mediaKind": "image", // "image" | "video" | "audio"
      "inPoint": 0, "volume": 1.0,
      "transform": { "x": 0, "y": 0, "scale": 1.0, "opacity": 1.0 }
    }
  ]
}
```

ルール
- `start` / `duration` / `inPoint` / `gapAfter` はフレーム単位の整数
- セリフの長さは `ceil(durationMs × fps / 1000)` に自動で合わせる（「長さを固定」した場合を除く）
- トラックの並び順が重なり順（配列の先頭＝画面で上のトラックほど手前に描く）

---

## 4. 音声合成エンジン

すべて同じ窓口（Rust の `TtsEngine` トレイト）にそろえる。

```rust
trait TtsEngine {
    fn id(&self) -> EngineId;
    fn status(&self) -> EngineStatus;              // 見つからない / 起動していない / 準備OK
    fn list_voices(&self) -> Result<Vec<Voice>>;
    fn synthesize(&self, req: &SynthRequest, out_wav: &Path) -> Result<()>;
}
```

| エンジン | 連携方法 | 注意 |
|---|---|---|
| VOICEPEAK | `voicepeak.exe -s 本文 -n 話者 -o 出力.wav [--speed] [--pitch] [-e 感情=値,…]` | 1回の入力は 140 文字程度まで → 句読点で分割して合成し、WAV を連結。同時実行しない。v1.2.1 以降 |
| VoiSona Talk | ローカル REST API（既定ポート 32766、ユーザー名＝サインインのメール、API パスワードで Basic 認証） | 合成要求 → UUID で状態を確認 → WAV を取得。エンドポイント名は Talk API Reference で最終確認し、`voisona.rs` の定数だけ直せばよい作りにしてある |
| VOICEVOX | ローカル HTTP API（既定 `127.0.0.1:50021`）：`/speakers` → `/audio_query` → `/synthesis` | exe の場所は不要（起動しておくだけ）。話者はスタイル ID。速さ・高さ（半音→対数 0.0578/半音、±0.15）・抑揚をクエリに書く。AivisSpeech など同じ API のエンジンはポートを変えて使える。動画には「VOICEVOX:キャラクター名」の表記が必要で、書き出し画面に出してコピーできる |
| A.I.VOICE | `aivoice-bridge.exe`（C#）が `TtsControl` を操作。`Initialize → StartHost → Connect → CurrentVoicePresetName / MasterControl / Text → SaveAudioToFile` | Windows 専用。エディタ1つにつき直列。A.I.VOICE2 で同じ API が使えるかは未確認 |

### bridge の通信（JSON Lines、1行1メッセージ）

```
→ {"id":1,"cmd":"status"}
← {"id":1,"ok":true,"result":{"status":"Idle","version":"1.4.x"}}
→ {"id":2,"cmd":"listVoices"}
← {"id":2,"ok":true,"result":["琴葉 茜","琴葉 葵"]}
→ {"id":3,"cmd":"synthesize","preset":"琴葉 茜","text":"こんにちは","params":{"Speed":1.0,"Pitch":1.0,"Volume":1.0,"PitchRange":1.0},"out":"C:\\…\\x.wav"}
← {"id":3,"ok":true,"result":{"out":"C:\\…\\x.wav"}}
← {"id":3,"ok":false,"error":"HostNotRunning"}
```

---

## 5. 書き出し

1. 未合成のセリフをすべて合成（キャッシュ済みは飛ばす）
2. 字幕を ASS ファイルに書き出す（キャラクターごとに Style を1つ）
3. FFmpeg の引数を組み立てる
   - 背景：`color=c=#000000:s=1920x1080:r=30`
   - 素材：画像・動画を `overlay=enable='between(t,開始,終了)'` で重ねる
   - 音声：各セリフ WAV を `adelay` でずらして `amix`（`normalize=0`）
   - 字幕：`ass=subtitles.ass`
   - 出力：H.264（`-preset veryfast -crf 20`）＋ AAC
4. `-progress pipe:1` を読み、進捗を UI にイベントで送る

---

## 5.5 立ち絵（口パク・目パチ）

- 立ち絵は「体・目×3・口×3」の透過 PNG（同じ大きさ）を重ねる。目・口は無くてもよい（無い差分は 1 つ目で代用）
- **口パク**：そのキャラクターのセリフの波形ピーク（100 個/秒）から、フレームごとにクリップ内最大音量との比を取り、0.2 以上で半開き、0.5 以上で開
- **目パチ**：キャラクター ID の FNV-1a をシードにした xorshift32 で 2.5〜5.5 秒ごとに瞬き（半目→閉→半目、各 fps/15 フレーム）
- 同じ計算を Rust（`core/src/lipsync.rs`）と TS（`app/src/lipsync.ts`）に持ち、`npm --prefix app run check:lipsync` で一致を確かめる
- 書き出しでは、使う状態の組み合わせだけ FFmpeg で 1 枚に合成し、「この画像を何秒」を並べた ffconcat を 1 本の映像として重ねる（フレームごとに切り替えてもフィルタが増えない）

## 5.6 タイムライン操作

- クリップの中央をドラッグで移動、両端（6px）をドラッグで長さ調整。ほかのクリップの端・再生位置・先頭に 8px 以内でスナップ（Alt で無効）
- セリフの長さを手で変えると、以後は音声長に合わせない（`lockDuration`）
- 音声長が変わったとき、直前に詰めて置かれていたセリフは詰め直し、手で離したセリフは位置を保つ（重なるときだけ押し出す）
- 素材は再生位置に追加（画像 5 秒、動画・音声は ffprobe で調べた長さ）。S キーで再生位置で分割
- ドラッグ中は画面上だけで動かし、離したときに 1 回だけ履歴に残す。文字入力・スライダーは 1 秒以内の連続変更を 1 つの履歴にまとめる

## 5.7 動画素材

- 追加すると ffprobe で長さ・大きさ・音声の有無を調べ、プレビュー用のプロキシ（高さ 360px、キーフレーム 0.5 秒間隔の H.264）をバックグラウンドで作る（1 本ずつ、進捗はタイムラインと右パネルに出る）
- プロキシは `アプリのキャッシュ/proxy/` に、元ファイルのパス・大きさ・更新日時から決めた名前で置く。素材を差し替えると作り直しになる
- プレビューは `<video>` を Canvas に描く。止まっているときは目的の時刻へシーク、再生中はずれが 0.2 秒を超えたらシークし直す
- 独自スキームの動画を直接読めない WebView（Linux の WebKitGTK など）では、2.5 秒たっても読めなければプロキシを Blob URL で読み直す
- 書き出しは元の素材から作る。動画に音声があれば切り出し位置・開始位置・音量を合わせてミックスする

## 5.8 字幕アニメーション

| 種類 | プレビュー（`subtitleAnim.ts`） | 書き出し（ASS） |
|---|---|---|
| フェード | 0.2 秒で不透明度 0↔1 | `\fad(200,200)` |
| ポップ | 0.2 秒で 85%→100%（進み具合の 0.5 乗） | `\fscx85\fscy85\t(0,200,0.5,\fscx100\fscy100)` |
| 1文字ずつ | 長さの 6 割か 1 文字 2 フレームの短いほうで全文を出す | 表示文字数が変わるごとに 1 行。まだの文字は `\alpha&HFF&` で透明（位置は全文で決まるので動かない） |

## 6. ディレクトリ

```
voxcut/
├─ ARCHITECTURE.md
├─ Cargo.toml                 Rust ワークスペース
├─ core/                      voxcut-core（Tauri 非依存、テスト付き）
│  └─ src/{model,cache,wav,waveform,subtitle,render,jobs}.rs, tts/{voicepeak,voisona,aivoice}.rs
├─ src-tauri/                 Tauri シェル（IPC コマンド）
├─ bridges/aivoice-bridge/    C# 補助プロセス
└─ app/                       フロントエンド（Vite + React + Astryx）
   └─ src/{theme,timeline,preview,inspector,ipc}/…
```

## 7. 今後の段階

| 段階 | 内容 |
|---|---|
| 1（済） | 雛形：データ形式、3エンジンの連携、キャッシュ、字幕付き書き出し、UI の骨組み |
| 2（済） | タイムライン編集（移動・端のドラッグで長さ調整・スナップ・素材の追加と分割・Undo/Redo） |
| 3（済） | 立ち絵（口パク・目パチ）、字幕アニメーション（フェード・ポップ・1文字ずつ） |
| 4（一部済） | 動画素材のプロキシ生成とプレビュー、動画の音声の書き出し（済）。ハードウェアエンコード（NVENC/QSV）は未着手 |
