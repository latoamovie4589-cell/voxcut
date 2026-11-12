//! VOICEVOX 連携（VOICEVOX ENGINE の HTTP API）。
//!
//! VOICEVOX を起動すると `http://127.0.0.1:50021` で API が開く。exe の場所は要らない。
//! 1. GET  /speakers                         … 話者とスタイル（スタイル ID が合成に使う番号）
//! 2. POST /audio_query?text=…&speaker=ID     … 読み・抑揚・速さなどの「クエリ」を作る
//! 3. POST /synthesis?speaker=ID（本文=クエリ） … WAV が返る
//!
//! 同じ形の API を持つエンジン（AivisSpeech は既定ポート 10101 など）も、ポートを変えれば使える。

use super::{EngineStatus, SynthRequest, TtsEngine, VoiceInfo};
use crate::model::{EngineId, VoiceParams};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const ENGINE: &str = "VOICEVOX";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VoicevoxConfig {
    pub host: String,
    pub port: u16,
}

impl Default for VoicevoxConfig {
    fn default() -> Self {
        Self { host: "127.0.0.1".into(), port: 50021 }
    }
}

pub struct VoicevoxEngine {
    cfg: VoicevoxConfig,
    agent: ureq::Agent,
}

impl VoicevoxEngine {
    pub fn new(cfg: VoicevoxConfig) -> Self {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_millis(800)).timeout(Duration::from_secs(120)).build();
        Self { cfg, agent }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}:{}{}", self.cfg.host, self.cfg.port, path)
    }

    fn map_err(&self, e: ureq::Error) -> Error {
        match e {
            ureq::Error::Status(code, r) => {
                Error::Engine { engine: ENGINE, detail: format!("HTTP {code}: {}", r.into_string().unwrap_or_default()) }
            }
            ureq::Error::Transport(t) => Error::EngineNotFound {
                engine: ENGINE,
                detail: format!("{}:{} に接続できません（VOICEVOX を起動してください）: {t}", self.cfg.host, self.cfg.port),
            },
        }
    }
}

/// モデルのパラメータを、VOICEVOX のクエリに書き込む。
/// 音量はクエリに入れない（書き出し時のミックスで掛け、全エンジンで同じ効き方にする）
pub fn apply_params(query: &mut Value, p: &VoiceParams) {
    query["speedScale"] = serde_json::json!(p.speed.clamp(0.5, 2.0));
    // pitchScale は対数の音高に足す値。半音 = ln(2)/12 ≒ 0.0578。VOICEVOX の範囲は ±0.15
    query["pitchScale"] = serde_json::json!((p.pitch * std::f64::consts::LN_2 / 12.0).clamp(-0.15, 0.15));
    query["intonationScale"] = serde_json::json!(p.intonation.clamp(0.0, 2.0));
}

/// /speakers の応答 → 話者一覧（スタイルごとに 1 件）
pub fn parse_speakers(v: &Value) -> Vec<VoiceInfo> {
    let mut out = vec![];
    for sp in v.as_array().into_iter().flatten() {
        let name = sp["name"].as_str().unwrap_or("?");
        for st in sp["styles"].as_array().into_iter().flatten() {
            // 歌唱用（sing / frame_decode）は読み上げに使えないので除く
            if st["type"].as_str().is_some_and(|t| t != "talk") {
                continue;
            }
            let Some(id) = st["id"].as_i64() else { continue };
            let style = st["name"].as_str().unwrap_or("");
            out.push(VoiceInfo {
                engine: EngineId::Voicevox,
                speaker: id.to_string(),
                display_name: if style.is_empty() { name.to_string() } else { format!("{name}（{style}）") },
                emotions: vec![],
                credit: Some(format!("VOICEVOX:{name}")),
            });
        }
    }
    out
}

impl TtsEngine for VoicevoxEngine {
    fn id(&self) -> EngineId {
        EngineId::Voicevox
    }

    fn max_concurrency(&self) -> usize {
        2
    }

    fn status(&self) -> EngineStatus {
        match self.agent.get(&self.url("/version")).call() {
            Ok(r) => EngineStatus::Ready { version: r.into_string().ok().map(|s| s.trim().trim_matches('"').to_string()) },
            Err(e) => match self.map_err(e) {
                Error::EngineNotFound { detail, .. } => EngineStatus::NotRunning { detail },
                other => EngineStatus::NotRunning { detail: other.to_string() },
            },
        }
    }

    fn list_voices(&self) -> Result<Vec<VoiceInfo>> {
        let v: Value = self.agent.get(&self.url("/speakers")).call().map_err(|e| self.map_err(e))?.into_json()?;
        Ok(parse_speakers(&v))
    }

    fn synthesize(&self, req: &SynthRequest<'_>, out_wav: &Path) -> Result<()> {
        let speaker: i64 = req
            .speaker
            .parse()
            .map_err(|_| Error::Engine { engine: ENGINE, detail: format!("話者の番号が正しくありません: {}", req.speaker) })?;
        let mut query: Value = self
            .agent
            .post(&self.url("/audio_query"))
            .query("text", req.text)
            .query("speaker", &speaker.to_string())
            .call()
            .map_err(|e| self.map_err(e))?
            .into_json()?;
        apply_params(&mut query, req.params);
        let res = self
            .agent
            .post(&self.url("/synthesis"))
            .query("speaker", &speaker.to_string())
            .send_json(query)
            .map_err(|e| self.map_err(e))?;
        let mut bytes = Vec::new();
        res.into_reader().read_to_end(&mut bytes)?;
        if bytes.len() < 44 || &bytes[0..4] != b"RIFF" {
            return Err(Error::Engine { engine: ENGINE, detail: "WAV ではない応答が返りました".into() });
        }
        std::fs::write(out_wav, bytes)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// VOICEVOX ENGINE のふりをする最小の HTTP サーバー。受け取ったクエリを記録する
    fn mock(seen: Arc<Mutex<Vec<String>>>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let mut s = s.unwrap();
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    r.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; len];
                r.read_exact(&mut body).unwrap();
                let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
                seen.lock().unwrap().push(format!("{} {}", line.split_whitespace().next().unwrap_or(""), target));
                let (ctype, resp): (&str, Vec<u8>) = if target == "/version" {
                    ("application/json", b"\"0.99.0\"".to_vec())
                } else if target == "/speakers" {
                    (
                        "application/json",
                        r#"[{"name":"ずんだもん","speaker_uuid":"u","styles":[{"name":"ノーマル","id":3,"type":"talk"},{"name":"ハミング","id":3001,"type":"frame_decode"}]},{"name":"四国めたん","styles":[{"name":"あまあま","id":0}]}]"#
                            .as_bytes()
                            .to_vec(),
                    )
                } else if target.starts_with("/audio_query") {
                    ("application/json", br#"{"accent_phrases":[],"speedScale":1.0,"pitchScale":0.0,"intonationScale":1.0,"volumeScale":1.0,"outputSamplingRate":24000}"#.to_vec())
                } else if target.starts_with("/synthesis") {
                    seen.lock().unwrap().push(String::from_utf8(body).unwrap());
                    let d = tempfile::tempdir().unwrap();
                    let p = d.path().join("t.wav");
                    crate::wav::write_tone(&p, 24000, 300, 440.0);
                    ("audio/wav", std::fs::read(p).unwrap())
                } else {
                    ("text/plain", b"not found".to_vec())
                };
                let code = if ctype == "text/plain" { 404 } else { 200 };
                write!(s, "HTTP/1.1 {code} X\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", resp.len()).unwrap();
                s.write_all(&resp).unwrap();
            }
        });
        port
    }

    #[test]
    fn full_flow_against_mock() {
        let seen = Arc::new(Mutex::new(vec![]));
        let port = mock(seen.clone());
        let eng = VoicevoxEngine::new(VoicevoxConfig { port, ..Default::default() });
        assert_eq!(eng.status(), EngineStatus::Ready { version: Some("0.99.0".into()) });

        let voices = eng.list_voices().unwrap();
        // 歌唱用スタイルは除く
        assert_eq!(voices.len(), 2);
        assert_eq!(voices[0].speaker, "3");
        assert_eq!(voices[0].display_name, "ずんだもん（ノーマル）");
        assert_eq!(voices[0].credit.as_deref(), Some("VOICEVOX:ずんだもん"));

        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("v.wav");
        let p = VoiceParams { speed: 1.2, pitch: 1.0, intonation: 1.5, ..Default::default() };
        eng.synthesize(&SynthRequest { speaker: "3", text: "こんにちは", params: &p }, &out).unwrap();
        assert_eq!(crate::wav::duration_ms(&out).unwrap(), 300);

        let log = seen.lock().unwrap().clone();
        let q = log.iter().find(|l| l.starts_with("POST /audio_query")).unwrap();
        assert!(q.contains("speaker=3") && q.contains("text=%E3%81%93"), "{q}");
        let sent: Value = serde_json::from_str(log.iter().find(|l| l.starts_with('{')).unwrap()).unwrap();
        assert_eq!(sent["speedScale"], 1.2);
        assert_eq!(sent["intonationScale"], 1.5);
        assert!((sent["pitchScale"].as_f64().unwrap() - 0.05776).abs() < 1e-4);
        // 音量はクエリで変えない（ミックスで掛ける）
        assert_eq!(sent["volumeScale"], 1.0);
    }

    #[test]
    fn not_running_is_reported() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let eng = VoicevoxEngine::new(VoicevoxConfig { port, ..Default::default() });
        match eng.status() {
            EngineStatus::NotRunning { detail } => assert!(detail.contains("VOICEVOX を起動")),
            s => panic!("{s:?}"),
        }
        assert!(eng.synthesize(&SynthRequest { speaker: "3", text: "x", params: &VoiceParams::default() }, Path::new("/tmp/x.wav")).is_err());
    }

    #[test]
    fn bad_speaker_id_is_an_error() {
        let eng = VoicevoxEngine::new(VoicevoxConfig::default());
        let e = eng.synthesize(&SynthRequest { speaker: "ずんだもん", text: "x", params: &VoiceParams::default() }, Path::new("/tmp/x.wav"));
        assert!(e.unwrap_err().to_string().contains("話者の番号"));
    }
}
