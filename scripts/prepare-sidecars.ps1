# インストーラーに同梱する実行ファイル（FFmpeg と A.I.VOICE 補助プロセス）を用意する。
# 使い方（リポジトリのルートで）：pwsh scripts/prepare-sidecars.ps1
#   -FfmpegZipUrl を変えると別の FFmpeg ビルドを使える（libx264 入りの GPL ビルドが必要）
param(
  [string]$FfmpegZipUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  [string]$Target = 'x86_64-pc-windows-msvc'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'src-tauri/binaries'
$tmp = Join-Path $root 'target/sidecar-tmp'
New-Item -ItemType Directory -Force -Path $bin, $tmp | Out-Null

# 1) FFmpeg
$ffmpegOut = Join-Path $bin "ffmpeg-$Target.exe"
if (-not (Test-Path $ffmpegOut)) {
  Write-Host "FFmpeg をダウンロードしています: $FfmpegZipUrl"
  $zip = Join-Path $tmp 'ffmpeg.zip'
  Invoke-WebRequest -Uri $FfmpegZipUrl -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'ffmpeg') -Force
  $dir = Get-ChildItem -Path (Join-Path $tmp 'ffmpeg') -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  Copy-Item $dir.FullName $ffmpegOut
  Copy-Item (Join-Path $dir.DirectoryName 'ffprobe.exe') (Join-Path $bin "ffprobe-$Target.exe")
  # libx264 が入っているか確かめる（書き出しに必要）
  $enc = & $ffmpegOut -hide_banner -encoders
  if (-not ($enc -match 'libx264')) { throw 'この FFmpeg には libx264 がありません。GPL ビルドを使ってください。' }
}

# 2) A.I.VOICE 補助プロセス（net48・追加 DLL なしの単一 exe）
Push-Location (Join-Path $root 'bridges/aivoice-bridge')
dotnet build -c Release | Out-Host
Pop-Location
Copy-Item (Join-Path $root 'bridges/aivoice-bridge/bin/Release/net48/aivoice-bridge.exe') (Join-Path $bin "aivoice-bridge-$Target.exe") -Force

Get-ChildItem $bin | Format-Table Name, Length
Write-Host '同梱する実行ファイルを用意しました'
