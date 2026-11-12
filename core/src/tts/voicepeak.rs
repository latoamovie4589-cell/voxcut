//! VOICEPEAK 連携（コマンドライン）。
//!
//! `voicepeak -s <本文> -n <ナレーター> -o <出力.wav> [--speed 50..200] [--pitch -300..300] [-e 感情=値,...]`
//! - 1回の入力は 140 文字程度までなので、句読点で分割して合成し連結する
//! - 同時に複数起動できないので直列で使う（max_concurrency = 1）
//! - YMM4 の案内どおり v1.2.1 以降が前提

use super::{hidden_command, EngineStatus, SynthRequest, TtsEngine, VoiceInfo};
use crate::model::{EngineId, VoiceParams};
use crate::{Error, Result};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_CHARS: usize = 140;
/// 分割したときのつなぎ目の無音
const JOIN_GAP_MS: u32 = 120;
const ENGINE: &str = "VOICEPEAK";

pub struct VoicepeakEngine {
    exe: Option<PathBuf>,
    /// VOICEPEAK は多重起動できないので、このプロセス内でも1件ずつにする
    lock: Mutex<()>,
}

impl VoicepeakEngine {
    pub fn new(configured: Option<PathBuf>) -> Self {
        // 場所は設定画面でユーザーが選ぶ
        Self { exe: configured, lock: Mutex::new(()) }
    }

    fn exe(&self) -> Result<&Path> {
        match &self.exe {
            Some(p) if p.is_file() => Ok(p),
            Some(p) => Err(Error::EngineNotFound { engine: ENGINE, detail: format!("{} がありません", p.display()) }),
            None => Err(Error::EngineNotFound { engine: ENGINE, detail: "設定で voicepeak.exe の場所を選んでください".into() }),
        }
    }

    fn run(&self, args: &[String]) -> Result<String> {
        let out = hidden_command(self.exe()?).args(args).output()?;
        if !out.status.success() {
            return Err(Error::Engine {
                engine: ENGINE,
                detail: format!("終了コード {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr).trim()),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// 合成コマンドの引数を組み立てる
pub fn synth_args(speaker: &str, text: &str, params: &VoiceParams, out: &Path) -> Vec<String> {
    let mut a = vec![
        "-s".into(),
        text.into(),
        "-n".into(),
        speaker.into(),
        "-o".into(),
        out.to_string_lossy().into_owned(),
    ];
    let speed = (params.speed * 100.0).round().clamp(50.0, 200.0) as i64;
    if speed != 100 {
        a.push("--speed".into());
        a.push(speed.to_string());
    }
    // VOICEPEAK の pitch はセント相当（-300..300）。モデルは半音で持つので ×100
    let pitch = (params.pitch * 100.0).round().clamp(-300.0, 300.0) as i64;
    if pitch != 0 {
        a.push("--pitch".into());
        a.push(pitch.to_string());
    }
    if !params.emotions.is_empty() {
        let e: Vec<String> = params
            .emotions
            .iter()
            .map(|(k, v)| format!("{k}={}", v.round().clamp(0.0, 100.0) as i64))
            .collect();
        a.push("-e".into());
        a.push(e.join(","));
    }
    a
}

/// `--list-narrator` / `--list-emotion` の出力（1行1項目）を読む
pub fn parse_list(stdout: &str) -> Vec<String> {
    stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

impl TtsEngine for VoicepeakEngine {
    fn id(&self) -> EngineId {
        EngineId::Voicepeak
    }

    fn status(&self) -> EngineStatus {
        match self.exe() {
            Ok(_) => EngineStatus::Ready { version: None },
            Err(e) => EngineStatus::NotFound { detail: e.to_string() },
        }
    }

    fn list_voices(&self) -> Result<Vec<VoiceInfo>> {
        let _g = self.lock.lock().unwrap();
        let names = parse_list(&self.run(&["--list-narrator".into()])?);
        let mut out = Vec::with_capacity(names.len());
        for n in names {
            let emotions = self.run(&["--list-emotion".into(), n.clone()]).map(|s| parse_list(&s)).unwrap_or_default();
            out.push(VoiceInfo { engine: EngineId::Voicepeak, display_name: n.clone(), speaker: n, emotions , credit: None });
        }
        Ok(out)
    }

    fn synthesize(&self, req: &SynthRequest<'_>, out_wav: &Path) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        let chunks = crate::text::split_for_engine(req.text, MAX_CHARS);
        if chunks.is_empty() {
            return Err(Error::Engine { engine: ENGINE, detail: "読み上げる文字がありません".into() });
        }
        if chunks.len() == 1 {
            self.run(&synth_args(req.speaker, &chunks[0], req.params, out_wav))?;
            return Ok(());
        }
        let parts: Vec<PathBuf> = (0..chunks.len()).map(|i| out_wav.with_extension(format!("part{i}.wav"))).collect();
        let result = (|| {
            for (c, p) in chunks.iter().zip(&parts) {
                self.run(&synth_args(req.speaker, c, req.params, p))?;
            }
            crate::wav::concat(&parts, JOIN_GAP_MS, out_wav)
        })();
        for p in &parts {
            let _ = std::fs::remove_file(p);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_default_params_are_minimal() {
        let a = synth_args("Japanese Female 1", "こんにちは", &VoiceParams::default(), Path::new("o.wav"));
        assert_eq!(a, vec!["-s", "こんにちは", "-n", "Japanese Female 1", "-o", "o.wav"]);
    }

    #[test]
    fn args_map_params() {
        let mut p = VoiceParams { speed: 1.25, pitch: -1.5, ..Default::default() };
        p.emotions.insert("happy".into(), 40.0);
        p.emotions.insert("angry".into(), 150.0);
        let a = synth_args("n", "t", &p, Path::new("o.wav"));
        assert_eq!(&a[6..], &["--speed", "125", "--pitch", "-150", "-e", "angry=100,happy=40"]);
    }

    #[test]
    fn parse_list_trims() {
        assert_eq!(parse_list("Japanese Male 1\r\n\r\n Japanese Female 1 \n"), vec!["Japanese Male 1", "Japanese Female 1"]);
    }

    /// 偽の voicepeak（python スクリプト）で、分割合成と連結までの流れを確かめる
    #[cfg(unix)]
    #[test]
    fn synthesize_with_fake_cli_splits_and_concats() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let log = d.path().join("calls.log");
        let fake = d.path().join("voicepeak");
        std::fs::write(
            &fake,
            format!(
                r#"#!/usr/bin/env python3
import sys, wave
a = sys.argv[1:]
open({log:?}, "a").write(" ".join(a) + "\n")
out = a[a.index("-o") + 1]
w = wave.open(out, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
w.writeframes(b"\x00\x00" * 4800)  # 100ms
w.close()
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let eng = VoicepeakEngine::new(Some(fake));
        assert!(matches!(eng.status(), EngineStatus::Ready { .. }));
        let text = format!("{}。{}。", "あ".repeat(100), "い".repeat(100));
        let out = d.path().join("out.wav");
        eng.synthesize(&SynthRequest { speaker: "Japanese Female 1", text: &text, params: &VoiceParams::default() }, &out)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 2);
        // 100ms ×2 ＋つなぎ 120ms
        assert_eq!(crate::wav::duration_ms(&out).unwrap(), 320);
        // 一時ファイルが残っていない
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 3);
    }
}
