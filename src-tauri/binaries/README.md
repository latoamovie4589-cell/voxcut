# サイドカー（同梱する実行ファイル）

ここに置いたファイルは、インストール先で VoxCut.exe と同じフォルダに入る。
名前の末尾にビルド先の「ターゲット名」が必要（Tauri の決まり）。

| ファイル | 用意のしかた |
|---|---|
| `ffmpeg-x86_64-pc-windows-msvc.exe` | `scripts/prepare-sidecars.ps1` がダウンロード |
| `ffprobe-x86_64-pc-windows-msvc.exe` | 同上 |
| `aivoice-bridge-x86_64-pc-windows-msvc.exe` | 同上（`bridges/aivoice-bridge` をビルド） |

実行ファイルそのものはリポジトリに入れない（.gitignore 済み）。
