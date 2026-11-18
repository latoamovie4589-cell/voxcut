//! CeVIO AI 連携（Windows の COM。PowerShell から呼ぶ）。
//!
//! CeVIO AI を入れると `CeVIO.Talk.RemoteService2.ServiceControl2V40`（起動）と `Talker2V40`（喋る）が使える。
//! キャスト（声）を選び、速さ・高さ・抑揚・感情（Components）を決めて `OutputWaveToFile` で WAV に書く。
//! 本文などは JSON のファイルで渡す（日本語や記号をそのまま渡すため）。

use super::{hidden_command, EngineStatus, SynthRequest, TtsEngine, VoiceInfo};
use crate::model::{EngineId, VoiceParams};
use crate::{Error, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const ENGINE: &str = "CeVIO AI";

/// PowerShell の台本。引数は JSON のファイル（op：status・list・synth）
pub const SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$req = Get-Content -Raw -Encoding UTF8 $args[0] | ConvertFrom-Json
try { $svc = New-Object -ComObject CeVIO.Talk.RemoteService2.ServiceControl2V40 } catch { $svc = New-Object -ComObject CeVIO.Talk.RemoteService2.ServiceControl2 }
if ($req.op -eq 'status') { 'ok'; exit 0 }
if (-not $svc.IsHostStarted) { $null = $svc.StartHost($false) }
$t = New-Object -ComObject CeVIO.Talk.RemoteService2.Talker2V40
if ($req.op -eq 'list') {
  $c = $t.AvailableCasts
  $out = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $c.Length; $i++) {
    $n = $c.At($i); $t.Cast = $n
    $e = New-Object System.Collections.ArrayList
    for ($j = 0; $j -lt $t.Components.Length; $j++) { $null = $e.Add($t.Components.At($j).Name) }
    $null = $out.Add(@{ name = $n; emotions = @($e) })
  }
  ConvertTo-Json -Compress -Depth 4 -InputObject @($out)
  exit 0
}
$t.Cast = $req.cast
$t.Volume = 50
$t.Speed = [uint32]$req.speed
$t.Tone = [uint32]$req.tone
$t.ToneScale = [uint32]$req.toneScale
$t.Alpha = [uint32]$req.alpha
foreach ($p in $req.emotions.PSObject.Properties) { $t.Components.ByName($p.Name).Value = [uint32]$p.Value }
if (-not $t.OutputWaveToFile($req.text, $req.out)) { throw 'WAV に書き出せませんでした' }
'ok'
"#;

pub struct CevioEngine {
    lock: Mutex<()>,
}

impl Default for CevioEngine {
    fn default() -> Self {
        Self { lock: Mutex::new(()) }
    }
}

/// 0〜100 の値（50 が標準）
fn unit(v: f64) -> f64 {
    v.round().clamp(0.0, 100.0)
}

/// 合成の頼み（速さ 1 倍＝50、2 倍＝100。高さは 1 半音で約 4。抑揚 1 倍＝50）
pub fn synth_request(cast: &str, text: &str, p: &VoiceParams, out: &Path) -> Value {
    let emotions: serde_json::Map<String, Value> = p.emotions.iter().map(|(k, v)| (k.clone(), json!(unit(*v)))).collect();
    json!({
        "op": "synth",
        "cast": cast,
        "text": text,
        "out": out.to_string_lossy(),
        "speed": unit(50.0 + 50.0 * p.speed.max(0.01).log2()),
        "tone": unit(50.0 + p.pitch * 50.0 / 12.0),
        "toneScale": unit(50.0 * p.intonation),
        "alpha": unit(p.extra.get("alpha").copied().unwrap_or(50.0)),
        "emotions": emotions,
    })
}

/// list の答え（[{name, emotions:[…]}]。1 つだけのときも配列）
pub fn parse_casts(s: &str) -> Vec<VoiceInfo> {
    let v: Value = serde_json::from_str(s.trim().trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
    let list = if v.is_array() { v.as_array().cloned().unwrap_or_default() } else if v.is_object() { vec![v] } else { vec![] };
    list.iter()
        .filter_map(|c| {
            let n = c["name"].as_str()?.to_string();
            let emotions = c["emotions"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            Some(VoiceInfo { engine: EngineId::Cevio, display_name: n.clone(), speaker: n, emotions, credit: None })
        })
        .collect()
}

impl CevioEngine {
    fn run(&self, req: &Value) -> Result<String> {
        if !cfg!(windows) {
            return Err(Error::EngineNotFound { engine: ENGINE, detail: "CeVIO AI は Windows だけで使えます".into() });
        }
        let dir = std::env::temp_dir().join(format!("voxcut-cevio-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let (ps1, js): (PathBuf, PathBuf) = (dir.join("cevio.ps1"), dir.join(format!("req{n}.json")));
        // BOM 付きにして、Windows PowerShell が UTF-8 として読むようにする
        std::fs::write(&ps1, format!("\u{feff}{SCRIPT}"))?;
        std::fs::write(&js, serde_json::to_vec(req)?)?;
        let o = hidden_command(Path::new("powershell.exe")).args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(&ps1).arg(&js).output();
        let _ = std::fs::remove_file(&js);
        let o = o.map_err(|e| Error::EngineNotFound { engine: ENGINE, detail: format!("PowerShell を起動できません: {e}") })?;
        if !o.status.success() {
            let err = String::from_utf8_lossy(&o.stderr);
            let detail = if err.contains("80040154") || err.contains("ComObject") { "CeVIO AI が見つかりません（入っているか確かめてください）".to_string() } else { err.trim().to_string() };
            return Err(Error::Engine { engine: ENGINE, detail });
        }
        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
    }
}

impl TtsEngine for CevioEngine {
    fn id(&self) -> EngineId {
        EngineId::Cevio
    }

    fn status(&self) -> EngineStatus {
        let _g = self.lock.lock().unwrap();
        match self.run(&json!({"op": "status"})) {
            Ok(_) => EngineStatus::Ready { version: None },
            Err(Error::EngineNotFound { detail, .. }) => EngineStatus::NotFound { detail },
            Err(e) => EngineStatus::NotFound { detail: e.to_string() },
        }
    }

    fn list_voices(&self) -> Result<Vec<VoiceInfo>> {
        let _g = self.lock.lock().unwrap();
        Ok(parse_casts(&self.run(&json!({"op": "list"}))?))
    }

    fn synthesize(&self, req: &SynthRequest<'_>, out_wav: &Path) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        self.run(&synth_request(req.speaker, req.text, req.params, out_wav))?;
        if !out_wav.is_file() {
            return Err(Error::Engine { engine: ENGINE, detail: "WAV ができませんでした".into() });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_and_casts() {
        let mut p = VoiceParams { speed: 2.0, pitch: 12.0, intonation: 1.0, ..Default::default() };
        p.emotions.insert("嬉しい".into(), 150.0);
        let r = synth_request("さとうささら", "こんにちは", &p, Path::new("o.wav"));
        assert_eq!((r["speed"].as_f64(), r["tone"].as_f64(), r["toneScale"].as_f64(), r["alpha"].as_f64()), (Some(100.0), Some(100.0), Some(50.0), Some(50.0)));
        assert_eq!(r["emotions"]["嬉しい"], 100.0);
        assert_eq!(synth_request("a", "b", &VoiceParams::default(), Path::new("o.wav"))["speed"], 50.0);
        let c = parse_casts("\u{feff}[{\"name\":\"さとうささら\",\"emotions\":[\"普通\",\"元気\"]}]");
        assert_eq!((c[0].speaker.as_str(), c[0].emotions.len()), ("さとうささら", 2));
        assert_eq!(parse_casts("{\"name\":\"小春六花\",\"emotions\":[]}").len(), 1);
        if !cfg!(windows) {
            assert!(matches!(CevioEngine::default().status(), EngineStatus::NotFound { .. }));
        }
    }
}
