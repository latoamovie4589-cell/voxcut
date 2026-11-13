//! A.I.VOICE 連携。
//!
//! A.I.VOICE の外部連携は .NET の Editor API（AI.Talk.Editor.Api.dll の TtsControl）しかないため、
//! C# の補助プロセス `aivoice-bridge.exe` を常駐させ、標準入出力の JSON Lines でやり取りする。
//! 起動は最初の1回だけなので、2件目以降は速い。

use super::{hidden_command, semitones_to_ratio, EngineStatus, SynthRequest, TtsEngine, VoiceInfo};
use crate::model::{EngineId, VoiceParams};
use crate::{Error, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::Mutex;

const ENGINE: &str = "A.I.VOICE";

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, r#"{{"id":0,"cmd":"quit"}}"#);
        let _ = self.child.wait();
    }
}

pub struct AivoiceEngine {
    bridge_path: Option<PathBuf>,
    /// A.I.VOICE のインストール先。補助プロセスに AIVOICE_DIR として渡す
    install_dir: Option<PathBuf>,
    bridge: Mutex<Option<Bridge>>,
}

impl AivoiceEngine {
    pub fn new(bridge_path: Option<PathBuf>) -> Self {
        Self { bridge_path: bridge_path.or_else(default_bridge_path), install_dir: None, bridge: Mutex::new(None) }
    }

    /// インストール先（ユーザーが選んだ AIVoiceEditor.exe のフォルダ）
    pub fn with_install_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.install_dir = dir;
        self
    }

    fn spawn(&self) -> Result<Bridge> {
        let path = self
            .bridge_path
            .as_ref()
            .filter(|p| p.is_file())
            .ok_or_else(|| Error::EngineNotFound { engine: ENGINE, detail: "aivoice-bridge が見つかりません".into() })?;
        let mut cmd = hidden_command(path);
        if let Some(dir) = &self.install_dir {
            cmd.env("AIVOICE_DIR", dir);
        }
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Ok(Bridge { child, stdin, stdout, next_id: 1 })
    }

    /// 1件送って1件受け取る。補助プロセスが落ちていたら1回だけ起動し直す。
    fn request(&self, mut msg: Value) -> Result<Value> {
        let mut guard = self.bridge.lock().unwrap();
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(self.spawn()?);
            }
            let b = guard.as_mut().unwrap();
            let id = b.next_id;
            b.next_id += 1;
            msg["id"] = json!(id);
            let sent = writeln!(b.stdin, "{msg}").and_then(|_| b.stdin.flush());
            let mut line = String::new();
            let read = sent.and_then(|_| b.stdout.read_line(&mut line));
            match read {
                Ok(n) if n > 0 => {
                    let v: Value = serde_json::from_str(line.trim())?;
                    if v["ok"].as_bool() == Some(true) {
                        return Ok(v["result"].clone());
                    }
                    let err = v["error"].as_str().unwrap_or("不明なエラー").to_string();
                    return Err(match err.as_str() {
                        "HostNotFound" => Error::EngineNotFound { engine: ENGINE, detail: "A.I.VOICE Editor がインストールされていません".into() },
                        _ => Error::Engine { engine: ENGINE, detail: err },
                    });
                }
                _ if attempt == 0 => {
                    *guard = None; // 落ちている → 作り直す
                }
                _ => {}
            }
        }
        Err(Error::Engine { engine: ENGINE, detail: "aivoice-bridge と通信できません".into() })
    }
}

fn default_bridge_path() -> Option<PathBuf> {
    // アプリ本体と同じフォルダに置く（Tauri の externalBin）
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "aivoice-bridge.exe" } else { "aivoice-bridge" };
    let p = exe.parent()?.join(name);
    p.is_file().then_some(p)
}

/// モデルのパラメータ → A.I.VOICE の MasterControl
/// Speed 0.5–4.0、Pitch 0.5–2.0（倍率）、PitchRange 0–2.0（抑揚）
/// 細かい調声：MiddlePause（短いポーズ 80–500 ミリ秒）、LongPause（長いポーズ 80–2000 ミリ秒）。指定したものだけ送る
pub fn master_control(p: &VoiceParams) -> Value {
    let mut m = json!({
        "Speed": p.speed.clamp(0.5, 4.0),
        "Pitch": semitones_to_ratio(p.pitch).clamp(0.5, 2.0),
        "PitchRange": p.intonation.clamp(0.0, 2.0),
    });
    if let Some(v) = p.extra.get("MiddlePause") {
        m["MiddlePause"] = json!(v.round().clamp(80.0, 500.0) as i64);
    }
    if let Some(v) = p.extra.get("LongPause") {
        m["LongPause"] = json!(v.round().clamp(80.0, 2000.0) as i64);
    }
    m
}

impl TtsEngine for AivoiceEngine {
    fn id(&self) -> EngineId {
        EngineId::Aivoice
    }

    fn status(&self) -> EngineStatus {
        if cfg!(windows) && self.install_dir.is_none() {
            return EngineStatus::NotFound { detail: "設定で AIVoiceEditor.exe の場所を選んでください".into() };
        }
        if !cfg!(windows) && self.bridge_path.is_none() {
            return EngineStatus::NotFound { detail: "A.I.VOICE は Windows 専用です".into() };
        }
        match self.request(json!({"cmd": "status"})) {
            Ok(v) => EngineStatus::Ready { version: v["version"].as_str().map(String::from) },
            Err(Error::EngineNotFound { detail, .. }) => EngineStatus::NotFound { detail },
            Err(e) => EngineStatus::NotRunning { detail: e.to_string() },
        }
    }

    fn list_voices(&self) -> Result<Vec<VoiceInfo>> {
        let v = self.request(json!({"cmd": "listVoices"}))?;
        Ok(v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(|n| VoiceInfo { engine: EngineId::Aivoice, speaker: n.into(), display_name: n.into(), emotions: vec![] , credit: None })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn synthesize(&self, req: &SynthRequest<'_>, out_wav: &Path) -> Result<()> {
        self.request(json!({
            "cmd": "synthesize",
            "preset": req.speaker,
            "text": req.text,
            "params": master_control(req.params),
            "out": out_wav.to_string_lossy(),
        }))?;
        if !out_wav.is_file() {
            return Err(Error::Engine { engine: ENGINE, detail: "WAV が作られていません".into() });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_control_mapping() {
        let m = master_control(&VoiceParams { speed: 1.5, pitch: 12.0, intonation: 3.0, ..Default::default() });
        assert_eq!(m["Speed"], 1.5);
        assert_eq!(m["Pitch"], 2.0);
        assert_eq!(m["PitchRange"], 2.0);
    }

    /// 偽の bridge（python）で JSON Lines の往復と、落ちたときの再起動を確かめる
    #[cfg(unix)]
    #[test]
    fn talks_json_lines_and_restarts() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let fake = d.path().join("aivoice-bridge");
        std::fs::write(
            &fake,
            r#"#!/usr/bin/env python3
import sys, json, wave
for line in sys.stdin:
    m = json.loads(line)
    c = m["cmd"]
    if c == "quit": break
    if c == "status": r = {"status": "Idle", "version": "1.4.0"}
    elif c == "listVoices": r = ["琴葉 茜", "琴葉 葵"]
    elif c == "synthesize":
        w = wave.open(m["out"], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(b"\x00\x00" * 4410); w.close(); r = {"out": m["out"]}
    elif c == "crash": sys.exit(1)
    print(json.dumps({"id": m["id"], "ok": True, "result": r}, ensure_ascii=False), flush=True)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let eng = AivoiceEngine::new(Some(fake));
        assert_eq!(eng.status(), EngineStatus::Ready { version: Some("1.4.0".into()) });
        assert_eq!(eng.list_voices().unwrap().len(), 2);
        // 補助プロセスを落としても、次の要求で起動し直す
        assert!(eng.request(json!({"cmd": "crash"})).is_err());
        let out = d.path().join("a.wav");
        let p = VoiceParams::default();
        eng.synthesize(&SynthRequest { speaker: "琴葉 茜", text: "テスト", params: &p, accent: None }, &out).unwrap();
        assert_eq!(crate::wav::duration_ms(&out).unwrap(), 100);
    }

    #[test]
    fn master_control_pauses_only_when_set() {
        let mut p = VoiceParams::default();
        let m = master_control(&p);
        assert!(m.get("MiddlePause").is_none() && m.get("LongPause").is_none());
        p.extra.insert("MiddlePause".into(), 40.0);
        p.extra.insert("LongPause".into(), 600.4);
        let m = master_control(&p);
        assert_eq!(m["MiddlePause"], 80);
        assert_eq!(m["LongPause"], 600);
    }
}
