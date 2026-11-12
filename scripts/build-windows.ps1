# Windows でインストーラー（NSIS）を作る。
# 必要なもの：Node.js 20 以上、Rust（stable, MSVC）、.NET SDK 8 以上
# 使い方（リポジトリのルートで）：pwsh scripts/build-windows.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
& (Join-Path $PSScriptRoot 'prepare-sidecars.ps1')
npm ci   # postinstall で app/ の依存も入る
npx tauri build
$out = Get-ChildItem (Join-Path $root 'target/release/bundle/nsis') -Filter '*.exe'
Write-Host "できました: $($out.FullName)"
