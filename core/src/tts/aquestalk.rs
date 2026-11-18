//! ゆっくりボイス（AquesTalkPlayer のコマンドライン）。
//!
//! Windows：`AquesTalkPlayer.exe /P <プリセット名> /T <本文> /W <出力.wav>`、Mac：`AquesTalkPlayer -P … -T … -W …`。
//! 声はプリセット（「れいむ」「まりさ」など、AquesTalkPlayer で作ったもの）で選ぶ。速さや高さもプリセットで決める
//! （コマンドラインでは変えられないため）。長い文は句読点で分けて合成し、つなぐ。

use super::{hidden_command, EngineStatus, SynthRequest, TtsEngine, VoiceInfo};
use crate::model::EngineId;
use crate::{Error, Result};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const ENGINE: &str = "AquesTalkPlayer";
/// 1 回に渡す文字数のめやす
pub const MAX_CHARS: usize = 120;
const JOIN_GAP_MS: u32 = 100;
/// はじめから入っているプリセット
pub const DEFAULT_PRESETS: [&str; 2] = ["れいむ", "まりさ"];

pub struct AquestalkEngine {
    exe: Option<PathBuf>,
    presets: Vec<String>,
    lock: Mutex<()>,
}

impl AquestalkEngine {
    /// exe：AquesTalkPlayer の場所。presets：設定で足したプリセット名（はじめからのものに足す）
    pub fn new(exe: Option<PathBuf>, presets: Vec<String>) -> Self {
        Self { exe, presets, lock: Mutex::new(()) }
    }

    fn exe(&self) -> Result<&Path> {
        match &self.exe {
            Some(p) if p.is_file() => Ok(p),
            Some(p) => Err(Error::EngineNotFound { engine: ENGINE, detail: format!("{} がありません", p.display()) }),
            None => Err(Error::EngineNotFound { engine: ENGINE, detail: "設定で AquesTalkPlayer の場所を選んでください".into() }),
        }
    }

    /// 使えるプリセット（はじめからのもの＋設定で足したもの。同じ名前は 1 つ）
    pub fn preset_names(&self) -> Vec<String> {
        let mut out: Vec<String> = DEFAULT_PRESETS.iter().map(|s| s.to_string()).collect();
        for p in &self.presets {
            let p = p.trim();
            if !p.is_empty() && !out.iter().any(|x| x == p) {
                out.push(p.to_string());
            }
        }
        out
    }

    fn run(&self, preset: &str, text: &str, out: &Path) -> Result<()> {
        let o = hidden_command(self.exe()?).args(synth_args(preset, text, out, cfg!(target_os = "macos"))).output()?;
        if !o.status.success() || !out.is_file() {
            return Err(Error::Engine {
                engine: ENGINE,
                detail: format!("終了コード {:?}（プリセット「{preset}」があるか確かめてください）{}", o.status.code(), String::from_utf8_lossy(&o.stderr).trim()),
            });
        }
        Ok(())
    }
}

/// 合成の引数（Mac は「-」、Windows は「/」で始める）
pub fn synth_args(preset: &str, text: &str, out: &Path, mac: bool) -> Vec<String> {
    let f = |k: &str| if mac { format!("-{k}") } else { format!("/{k}") };
    vec![f("P"), preset.into(), f("T"), text.replace(['\r', '\n'], " "), f("W"), out.to_string_lossy().into_owned()]
}

impl TtsEngine for AquestalkEngine {
    fn id(&self) -> EngineId {
        EngineId::Aquestalk
    }

    fn status(&self) -> EngineStatus {
        match self.exe() {
            Ok(_) => EngineStatus::Ready { version: None },
            Err(e) => EngineStatus::NotFound { detail: e.to_string() },
        }
    }

    fn list_voices(&self) -> Result<Vec<VoiceInfo>> {
        self.exe()?;
        Ok(self.preset_names().into_iter().map(|n| VoiceInfo { engine: EngineId::Aquestalk, display_name: n.clone(), speaker: n, emotions: vec![], credit: None }).collect())
    }

    fn synthesize(&self, req: &SynthRequest<'_>, out_wav: &Path) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        let chunks = crate::text::split_for_engine(req.text, MAX_CHARS);
        if chunks.is_empty() {
            return Err(Error::Engine { engine: ENGINE, detail: "読み上げる文字がありません".into() });
        }
        if chunks.len() == 1 {
            return self.run(req.speaker, &chunks[0], out_wav);
        }
        let parts: Vec<PathBuf> = (0..chunks.len()).map(|i| out_wav.with_extension(format!("part{i}.wav"))).collect();
        let r = (|| {
            for (c, p) in chunks.iter().zip(&parts) {
                self.run(req.speaker, c, p)?;
            }
            crate::wav::concat(&parts, JOIN_GAP_MS, out_wav)
        })();
        for p in &parts {
            let _ = std::fs::remove_file(p);
        }
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_and_presets() {
        assert_eq!(synth_args("れいむ", "ゆっくり\nしていってね", Path::new("o.wav"), false), ["/P", "れいむ", "/T", "ゆっくり していってね", "/W", "o.wav"]);
        assert_eq!(synth_args("まりさ", "a", Path::new("o.wav"), true)[0], "-P");
        let e = AquestalkEngine::new(None, vec!["まりさ".into(), " 機械 ".into(), "".into()]);
        assert_eq!(e.preset_names(), ["れいむ", "まりさ", "機械"]);
        assert!(matches!(e.status(), EngineStatus::NotFound { .. }));
    }

    /// 偽の AquesTalkPlayer（python スクリプト）で、プリセットと本文を渡して WAV ができるまで
    #[cfg(unix)]
    #[test]
    fn synthesize_with_fake_cli() {
        use crate::model::VoiceParams;
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let log = d.path().join("calls.log");
        let fake = d.path().join("AquesTalkPlayer");
        std::fs::write(
            &fake,
            format!(
                r#"#!/usr/bin/env python3
import sys, wave
a = sys.argv[1:]
open({log:?}, "a").write(" ".join(a) + "\n")
k = "-W" if "-W" in a else "/W"
w = wave.open(a[a.index(k) + 1], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"\x00\x00" * 1600)
w.close()
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = AquestalkEngine::new(Some(fake), vec![]);
        let out = d.path().join("o.wav");
        e.synthesize(&SynthRequest { speaker: "まりさ", text: "ゆっくりしていってね", params: &VoiceParams::default(), accent: None }, &out).unwrap();
        assert_eq!(crate::wav::duration_ms(&out).unwrap(), 100);
        assert!(std::fs::read_to_string(&log).unwrap().contains("まりさ"));
        assert_eq!(e.list_voices().unwrap().len(), 2);
    }
}
