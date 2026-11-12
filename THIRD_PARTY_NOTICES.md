# 同梱しているソフトウェア

## FFmpeg（ffmpeg.exe / ffprobe.exe）

- 動画の書き出し、素材の情報の取得、プレビュー用動画の作成に使っています
- VoxCut 本体とは別のプログラムとして同梱し、コマンドラインで呼び出しています
- 同梱しているのは BtbN/FFmpeg-Builds の Windows 向け GPL ビルドで、GNU General Public License version 3 で配布されています
  （H.264 の書き出しに libx264 を使うため GPL ビルドを使っています）
- ライセンス全文：https://www.gnu.org/licenses/gpl-3.0.html
- ソースコード：https://ffmpeg.org/download.html ／ ビルド設定：https://github.com/BtbN/FFmpeg-Builds
- 同梱したビルドの版は、インストール先で `ffmpeg.exe -version` を実行すると確認できます

## 音声合成ソフトについて

A.I.VOICE・VOICEPEAK・VoiSona Talk・VOICEVOX は同梱していません。それぞれの製品を各社から購入・インストールしてください。
A.I.VOICE の API（AI.Talk.Editor.Api.dll）も同梱せず、実行時にインストール先から読み込みます。
各製品の利用規約（動画での利用やクレジット表記など）に従ってください。VOICEVOX はキャラクターごとに「VOICEVOX:キャラクター名」の表記が必要で、VoxCut の書き出し画面に一覧が出ます。
