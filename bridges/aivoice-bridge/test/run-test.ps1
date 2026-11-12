# 補助プロセスを偽の A.I.VOICE API で動かして、JSON Lines のやり取りを確かめる（CI でも使う）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
dotnet build "$PSScriptRoot/FakeApi/FakeApi.csproj" -c Release -o "$PSScriptRoot/out/api" | Out-Null
$exe = Join-Path $root 'bin/Release/net48/aivoice-bridge.exe'
$outFile = Join-Path $PSScriptRoot 'out/o.txt'
$req = @(
  '{"id":1,"cmd":"status"}',
  '{"id":2,"cmd":"listVoices"}',
  ('{"id":3,"cmd":"synthesize","preset":"琴葉 葵","text":"テストです","params":{"Speed":1.25},"out":' + (ConvertTo-Json $outFile) + '}'),
  '{"id":0,"cmd":"quit"}'
) -join "`n"
$env:AIVOICE_DIR = "$PSScriptRoot/out/api"
$psi = New-Object System.Diagnostics.ProcessStartInfo $exe
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false
$psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
$p = [System.Diagnostics.Process]::Start($psi)
$w = New-Object System.IO.StreamWriter($p.StandardInput.BaseStream, [System.Text.UTF8Encoding]::new($false))
$w.Write($req + "`n"); $w.Flush(); $w.Close()
$res = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
Write-Host $res
if ($res -notmatch '"version":"9.9.9-fake"') { throw 'status が返りません' }
if ($res -notmatch '琴葉 茜') { throw 'listVoices が返りません' }
$saved = Get-Content $outFile -Raw -Encoding UTF8
if ($saved -notmatch '琴葉 葵\|テストです\|.*"Speed":1.25') { throw "合成の設定が渡っていません: $saved" }
Write-Host 'aivoice-bridge: OK'
