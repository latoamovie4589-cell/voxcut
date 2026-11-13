//! VoiSona Talk 連携（ローカル REST API）。
//!
//! 公式チュートリアルで確認できたこと：
//! - 既定ポートは 32766（環境設定 → API で変更可）
//! - 認証はユーザー名（サインインしたメールアドレス）と API パスワード
//! - 合成要求で UUID が返り、その UUID で状態（待機・処理中・完了・失敗）を確認する
//!
//! エンドポイント名と JSON のフィールド名は、アプリ内リンクの「Talk API Reference」で最終確認すること。
//! 変える必要があれば `api` モジュールの定数とリクエスト組み立てだけを直せばよい。

use super::{EngineStatus, SynthRequest, TtsEngine, VoiceInfo};
use crate::model::{EngineId, VoiceParams};
use crate::{Error, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

const ENGINE: &str = "VoiSona Talk";

pub mod api {
    //! ※要確認：Talk API Reference に合わせて調整する箇所
    pub const BASE_PATH: &str = "/api/talk/v1";
    pub const VOICES: &str = "/voices";
    pub const SYNTH: &str = "/speech-syntheses";
    pub const LANGUAGE: &str = "ja_JP";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VoisonaConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// 合成1件あたりの待ち時間の上限（秒）
    pub timeout_secs: u64,
}

impl Default for VoisonaConfig {
    fn default() -> Self {
        Self { host: "127.0.0.1".into(), port: 32766, user: String::new(), password: String::new(), timeout_secs: 60 }
    }
}

pub struct VoisonaEngine {
    cfg: VoisonaConfig,
    agent: ureq::Agent,
}

impl VoisonaEngine {
    pub fn new(cfg: VoisonaConfig) -> Self {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_millis(800)).timeout(Duration::from_secs(30)).build();
        Self { cfg, agent }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}:{}{}{}", self.cfg.host, self.cfg.port, api::BASE_PATH, path)
    }

    fn auth(&self) -> String {
        let raw = format!("{}:{}", self.cfg.user, self.cfg.password);
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
    }

    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let req = self.agent.request(method, &self.url(path)).set("Authorization", &self.auth());
        let res = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };
        match res {
            Ok(r) => {
                let text = r.into_string()?;
                if text.trim().is_empty() {
                    Ok(Value::Null)
                } else {
                    Ok(serde_json::from_str(&text)?)
                }
            }
            Err(ureq::Error::Status(401, _)) => Err(Error::Engine {
                engine: ENGINE,
                detail: "認証に失敗しました。設定のメールアドレスと API パスワードを確認してください".into(),
            }),
            Err(ureq::Error::Status(code, r)) => {
                Err(Error::Engine { engine: ENGINE, detail: format!("HTTP {code}: {}", r.into_string().unwrap_or_default()) })
            }
            Err(ureq::Error::Transport(t)) => Err(Error::EngineNotFound {
                engine: ENGINE,
                detail: format!("{}:{} に接続できません（VoiSona Talk を起動し、API を有効にしてください）: {t}", self.cfg.host, self.cfg.port),
            }),
        }
    }
}

/// モデルのパラメータ → VoiSona のグローバルパラメータ
pub fn global_parameters(p: &VoiceParams) -> Value {
    let mut g = json!({
        "speed": p.speed,
        // VoiSona の pitch はセント（モデルは半音）
        "pitch": p.pitch * 100.0,
        "intonation": p.intonation,
    });
    // 細かい調声：alp（声の若さ・大人っぽさ -1〜1）、huskiness（かすれ -20〜20）
    if let Some(v) = p.extra.get("alp") {
        g["alp"] = json!(v.clamp(-1.0, 1.0));
    }
    if let Some(v) = p.extra.get("huskiness") {
        g["huskiness"] = json!(v.clamp(-20.0, 20.0));
    }
    if !p.emotions.is_empty() {
        // スタイル名の並び順はボイスごとに決まっているので、名前付きで渡しておき、
        // 実際の並びは list_voices で得た順に合わせて送る（TODO: API Reference で形式確認）
        g["style_weights"] = json!(p.emotions);
    }
    g
}

pub fn synth_body(speaker: &str, text: &str, params: &VoiceParams, out: &Path) -> Value {
    json!({
        "language": api::LANGUAGE,
        "text": text,
        "voice_name": speaker,
        "global_parameters": global_parameters(params),
        "destination": "file",
        "output_file_path": out.to_string_lossy(),
        "can_overwrite_file": true,
    })
}

fn find_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_str))
}

impl TtsEngine for VoisonaEngine {
    fn id(&self) -> EngineId {
        EngineId::Voisona
    }

    fn max_concurrency(&self) -> usize {
        2
    }

    fn status(&self) -> EngineStatus {
        if self.cfg.user.is_empty() {
            return EngineStatus::NotFound { detail: "設定で VoiSona のメールアドレスと API パスワードを入力してください".into() };
        }
        match self.call("GET", api::VOICES, None) {
            Ok(_) => EngineStatus::Ready { version: None },
            Err(Error::EngineNotFound { detail, .. }) => EngineStatus::NotRunning { detail },
            Err(e) => EngineStatus::NotRunning { detail: e.to_string() },
        }
    }

    fn list_voices(&self) -> Result<Vec<VoiceInfo>> {
        let v = self.call("GET", api::VOICES, None)?;
        let items = v.get("items").and_then(Value::as_array).or_else(|| v.as_array()).cloned().unwrap_or_default();
        Ok(items
            .iter()
            .filter_map(|it| {
                let name = find_str(it, &["voice_name", "name"])?.to_string();
                let display = it
                    .get("display_names")
                    .and_then(Value::as_array)
                    .and_then(|a| a.iter().find(|d| d.get("language").and_then(Value::as_str) == Some(api::LANGUAGE)))
                    .and_then(|d| d.get("name").and_then(Value::as_str))
                    .unwrap_or(&name)
                    .to_string();
                let emotions = it
                    .get("styles")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|s| s.as_str().or_else(|| find_str(s, &["name"]))).map(String::from).collect())
                    .unwrap_or_default();
                Some(VoiceInfo { engine: EngineId::Voisona, speaker: name, display_name: display, emotions , credit: None })
            })
            .collect())
    }

    fn synthesize(&self, req: &SynthRequest<'_>, out_wav: &Path) -> Result<()> {
        let res = self.call("POST", api::SYNTH, Some(synth_body(req.speaker, req.text, req.params, out_wav)))?;
        let uuid = find_str(&res, &["uuid", "id"])
            .ok_or_else(|| Error::Engine { engine: ENGINE, detail: format!("UUID が返りませんでした: {res}") })?
            .to_string();
        let deadline = Instant::now() + Duration::from_secs(self.cfg.timeout_secs);
        let mut wait = Duration::from_millis(40);
        loop {
            let st = self.call("GET", &format!("{}/{uuid}", api::SYNTH), None)?;
            let state = find_str(&st, &["state", "status"]).unwrap_or("").to_ascii_lowercase();
            match state.as_str() {
                "succeeded" | "completed" | "done" => break,
                "failed" | "error" => {
                    return Err(Error::Engine { engine: ENGINE, detail: format!("合成に失敗しました: {st}") });
                }
                _ => {}
            }
            if Instant::now() > deadline {
                return Err(Error::Engine { engine: ENGINE, detail: "合成がタイムアウトしました".into() });
            }
            std::thread::sleep(wait);
            wait = (wait * 2).min(Duration::from_millis(300));
        }
        // サーバー側の要求を片付ける（数に上限があるため）。失敗しても合成結果には影響しない
        let _ = self.call("DELETE", &format!("{}/{uuid}", api::SYNTH), None);
        if !out_wav.is_file() {
            return Err(Error::Engine { engine: ENGINE, detail: format!("WAV が作られていません: {}", out_wav.display()) });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// VoiSona のふりをする最小の HTTP サーバー
    fn mock_server(log: Arc<Mutex<Vec<String>>>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut polls = 0;
            for s in l.incoming() {
                let mut s = s.unwrap();
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let mut len = 0usize;
                let mut auth = String::new();
                loop {
                    let mut h = String::new();
                    r.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                    let lower = h.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                    if lower.starts_with("authorization:") {
                        auth = h.trim().to_string();
                    }
                }
                let mut body = vec![0; len];
                r.read_exact(&mut body).unwrap();
                let body = String::from_utf8(body).unwrap();
                let req = line.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
                log.lock().unwrap().push(format!("{req} {auth}"));
                let (code, resp) = if !auth.ends_with("dTpwdw==") {
                    // "u:pw" の base64 は "dTpwdw=="
                    (401, "{}".to_string())
                } else if req == "GET /api/talk/v1/voices" {
                    (200, r#"{"items":[{"voice_name":"tanaka-san_ja_JP","display_names":[{"language":"ja_JP","name":"田中傘"}]}]}"#.into())
                } else if req == "POST /api/talk/v1/speech-syntheses" {
                    let v: Value = serde_json::from_str(&body).unwrap();
                    let out = v["output_file_path"].as_str().unwrap().to_string();
                    crate::wav::write_tone(Path::new(&out), 48000, 200, 300.0);
                    (200, r#"{"uuid":"abc"}"#.into())
                } else if req == "GET /api/talk/v1/speech-syntheses/abc" {
                    polls += 1;
                    let st = if polls < 2 { "running" } else { "succeeded" };
                    (200, format!(r#"{{"state":"{st}"}}"#))
                } else {
                    (200, String::new())
                };
                write!(s, "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp}", resp.len()).unwrap();
            }
        });
        port
    }

    fn cfg(port: u16, pw: &str) -> VoisonaConfig {
        VoisonaConfig { port, user: "u".into(), password: pw.into(), timeout_secs: 5, ..Default::default() }
    }

    #[test]
    fn full_flow_against_mock() {
        let log = Arc::new(Mutex::new(vec![]));
        let port = mock_server(log.clone());
        let eng = VoisonaEngine::new(cfg(port, "pw"));
        let st = eng.status();
        assert!(matches!(st, EngineStatus::Ready { .. }), "{st:?}");
        let voices = eng.list_voices().unwrap();
        assert_eq!(voices[0].speaker, "tanaka-san_ja_JP");
        assert_eq!(voices[0].display_name, "田中傘");

        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("v.wav");
        let p = VoiceParams::default();
        eng.synthesize(&SynthRequest { speaker: "tanaka-san_ja_JP", text: "テスト", params: &p, accent: None }, &out).unwrap();
        assert_eq!(crate::wav::duration_ms(&out).unwrap(), 200);
        let calls = log.lock().unwrap().clone();
        assert!(calls.iter().any(|c| c.starts_with("DELETE /api/talk/v1/speech-syntheses/abc")));
    }

    #[test]
    fn wrong_password_is_reported() {
        let port = mock_server(Arc::new(Mutex::new(vec![])));
        let eng = VoisonaEngine::new(cfg(port, "bad"));
        let err = eng.list_voices().unwrap_err().to_string();
        assert!(err.contains("API パスワード"), "{err}");
    }

    #[test]
    fn not_running_is_reported() {
        // 使われていないポート
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let eng = VoisonaEngine::new(cfg(port, "pw"));
        assert!(matches!(eng.status(), EngineStatus::NotRunning { .. }));
    }

    #[test]
    fn body_maps_pitch_to_cents() {
        let p = VoiceParams { pitch: 2.0, speed: 1.2, ..Default::default() };
        let b = synth_body("v", "t", &p, Path::new("/x.wav"));
        assert_eq!(b["global_parameters"]["pitch"], 200.0);
        assert_eq!(b["global_parameters"]["speed"], 1.2);
        assert_eq!(b["language"], "ja_JP");
    }

    #[test]
    fn extra_alp_and_huskiness() {
        let mut p = VoiceParams::default();
        assert!(global_parameters(&p).get("alp").is_none());
        p.extra.insert("alp".into(), 2.0);
        p.extra.insert("huskiness".into(), -5.0);
        let g = global_parameters(&p);
        assert_eq!(g["alp"], 1.0);
        assert_eq!(g["huskiness"], -5.0);
    }
}
