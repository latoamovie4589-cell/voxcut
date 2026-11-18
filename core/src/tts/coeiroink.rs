//! COEIROINK 連携（v2 の HTTP API）。
//!
//! COEIROINK v2 を起動すると `http://127.0.0.1:50032` で API が開く。
//! 1. GET  /v1/speakers   … 話者（speakerUuid）とスタイル（styleId）
//! 2. POST /v1/synthesis  … 本文と話者・スタイル・速さなどの JSON を送ると WAV が返る
//!
//! 話者は「speakerUuid:styleId」の形で持つ。COEIROINK v1 は VOICEVOX と同じ形の API なので、VOICEVOX のポートを 50031 にすれば使える。

use super::{EngineStatus, SynthRequest, TtsEngine, VoiceInfo};
use crate::model::{EngineId, VoiceParams};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const ENGINE: &str = "COEIROINK";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CoeiroinkConfig {
    pub host: String,
    pub port: u16,
}

impl Default for CoeiroinkConfig {
    fn default() -> Self {
        Self { host: "127.0.0.1".into(), port: 50032 }
    }
}

pub struct CoeiroinkEngine {
    cfg: CoeiroinkConfig,
    agent: ureq::Agent,
}

impl CoeiroinkEngine {
    pub fn new(cfg: CoeiroinkConfig) -> Self {
        let agent = ureq::AgentBuilder::new().try_proxy_from_env(false).timeout_connect(Duration::from_millis(800)).timeout(Duration::from_secs(120)).build();
        Self { cfg, agent }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}:{}{path}", self.cfg.host, self.cfg.port)
    }

    fn map_err(&self, e: ureq::Error) -> Error {
        match e {
            ureq::Error::Status(code, r) => Error::Engine { engine: ENGINE, detail: format!("HTTP {code}: {}", r.into_string().unwrap_or_default()) },
            ureq::Error::Transport(t) => Error::EngineNotFound { engine: ENGINE, detail: format!("COEIROINK に接続できません（{}:{}）。COEIROINK v2 を起動してください: {t}", self.cfg.host, self.cfg.port) },
        }
    }
}

/// /v1/speakers の答えを、スタイルごとの声にする
pub fn parse_speakers(v: &Value) -> Vec<VoiceInfo> {
    let mut out = vec![];
    for sp in v.as_array().into_iter().flatten() {
        let name = sp["speakerName"].as_str().unwrap_or_default();
        let uuid = sp["speakerUuid"].as_str().unwrap_or_default();
        for st in sp["styles"].as_array().into_iter().flatten() {
            let (Some(id), sn) = (st["styleId"].as_i64(), st["styleName"].as_str().unwrap_or_default()) else { continue };
            out.push(VoiceInfo { engine: EngineId::Coeiroink, speaker: format!("{uuid}:{id}"), display_name: format!("{name}（{sn}）"), emotions: vec![], credit: Some(format!("COEIROINK:{name}")) });
        }
    }
    out
}

/// 合成に送る JSON（速さ・高さ・抑揚は VOICEVOX と同じ考え方。音量は書き出しのミックスで掛けるので 1）
pub fn synth_body(speaker: &str, text: &str, p: &VoiceParams) -> Result<Value> {
    let (uuid, style) = speaker.rsplit_once(':').ok_or_else(|| Error::Engine { engine: ENGINE, detail: format!("話者の形が正しくありません: {speaker}") })?;
    let style: i64 = style.parse().map_err(|_| Error::Engine { engine: ENGINE, detail: format!("スタイルの番号が正しくありません: {speaker}") })?;
    let ex = |k: &str, d: f64| p.extra.get(k).copied().unwrap_or(d);
    Ok(json!({
        "speakerUuid": uuid,
        "styleId": style,
        "text": text,
        "prosodyDetail": [],
        "speedScale": p.speed.clamp(0.5, 2.0),
        "volumeScale": 1.0,
        "pitchScale": (p.pitch * std::f64::consts::LN_2 / 12.0).clamp(-0.15, 0.15),
        "intonationScale": p.intonation.clamp(0.0, 2.0),
        "prePhonemeLength": ex("prePhonemeLength", 0.1).clamp(0.0, 1.5),
        "postPhonemeLength": ex("postPhonemeLength", 0.1).clamp(0.0, 1.5),
        "outputSamplingRate": 48000,
    }))
}

impl TtsEngine for CoeiroinkEngine {
    fn id(&self) -> EngineId {
        EngineId::Coeiroink
    }

    fn max_concurrency(&self) -> usize {
        2
    }

    fn status(&self) -> EngineStatus {
        match self.agent.get(&self.url("/v1/speakers")).call() {
            Ok(_) => EngineStatus::Ready { version: None },
            Err(e) => match self.map_err(e) {
                Error::EngineNotFound { detail, .. } => EngineStatus::NotRunning { detail },
                other => EngineStatus::NotRunning { detail: other.to_string() },
            },
        }
    }

    fn list_voices(&self) -> Result<Vec<VoiceInfo>> {
        let v: Value = self.agent.get(&self.url("/v1/speakers")).call().map_err(|e| self.map_err(e))?.into_json()?;
        Ok(parse_speakers(&v))
    }

    fn synthesize(&self, req: &SynthRequest<'_>, out_wav: &Path) -> Result<()> {
        let body = synth_body(req.speaker, req.text, req.params)?;
        let res = self.agent.post(&self.url("/v1/synthesis")).send_json(body).map_err(|e| self.map_err(e))?;
        let mut bytes = vec![];
        res.into_reader().read_to_end(&mut bytes)?;
        if !bytes.starts_with(b"RIFF") {
            return Err(Error::Engine { engine: ENGINE, detail: "WAV ではない応答が返りました".into() });
        }
        std::fs::write(out_wav, bytes)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speakers_and_body() {
        let v: Value = serde_json::from_str(r#"[{"speakerName":"つくよみちゃん","speakerUuid":"3c37","styles":[{"styleName":"れいせい","styleId":0},{"styleName":"おしとやか","styleId":5}]}]"#).unwrap();
        let s = parse_speakers(&v);
        assert_eq!(s.len(), 2);
        assert_eq!(s[1].speaker, "3c37:5");
        assert_eq!(s[1].display_name, "つくよみちゃん（おしとやか）");
        assert_eq!(s[0].credit.as_deref(), Some("COEIROINK:つくよみちゃん"));
        let b = synth_body("3c37:5", "こんにちは", &VoiceParams { speed: 1.2, pitch: 1.0, ..Default::default() }).unwrap();
        assert_eq!(b["styleId"], 5);
        assert_eq!(b["speakerUuid"], "3c37");
        assert_eq!(b["prosodyDetail"], json!([]));
        assert!((b["pitchScale"].as_f64().unwrap() - 0.05776).abs() < 1e-4);
        assert!(synth_body("nouuid", "x", &VoiceParams::default()).is_err());
    }

    #[test]
    fn not_running_is_reported() {
        let e = CoeiroinkEngine::new(CoeiroinkConfig { host: "127.0.0.1".into(), port: 9 });
        assert!(matches!(e.status(), EngineStatus::NotRunning { .. }));
    }
}
