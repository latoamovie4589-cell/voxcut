//! エフェクトのプラグイン：プラグインのフォルダに置いた JSON で、映像エフェクトを足せる。
//! 1 つのエフェクトは、書き出しの FFmpeg のフィルター（1 つの並び）と、画面の Canvas の filter を、{名前} の数を入れる形で書く。
//! プロジェクトには入れた後の式ごと保存するので、プラグインを消しても同じように書き出せる。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// プラグインのファイル（.json）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub name: String,
    #[serde(default)]
    pub effects: Vec<PluginEffect>,
}

/// プラグインのエフェクト
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginEffect {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub params: Vec<PluginParam>,
    /// 書き出しの FFmpeg のフィルター（例：hue=h={deg}）
    pub ffmpeg: String,
    /// 画面の Canvas の filter（例：hue-rotate({deg}deg)）。なければ画面では掛けない
    #[serde(default)]
    pub canvas: String,
}

/// エフェクトの数（スライダー）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginParam {
    pub key: String,
    pub label: String,
    pub min: f64,
    pub max: f64,
    #[serde(default = "step")]
    pub step: f64,
    pub default: f64,
}

fn step() -> f64 {
    0.01
}

/// 読み込んだプラグイン（読めなかったものは error）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub file: String,
    pub plugin: Option<Plugin>,
    pub error: Option<String>,
}

/// はじめてフォルダを作ったときに置く見本
pub const SAMPLE: &str = r#"{
  "name": "見本",
  "effects": [
    {
      "id": "sample-hue",
      "label": "色相をずらす（見本）",
      "params": [{"key": "deg", "label": "角度", "min": -180, "max": 180, "step": 1, "default": 90}],
      "ffmpeg": "hue=h={deg}",
      "canvas": "hue-rotate({deg}deg)"
    }
  ]
}
"#;

/// フォルダの .json を名前の順に読む（フォルダがなければ作って見本を置く）
pub fn load_dir(dir: &Path) -> Vec<Loaded> {
    if !dir.exists() && std::fs::create_dir_all(dir).is_ok() {
        let _ = std::fs::write(dir.join("見本.json"), SAMPLE);
    }
    let mut files: Vec<_> = std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("json"))).collect()).unwrap_or_default();
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let file = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            match std::fs::read_to_string(&p).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Plugin>(&t).map_err(|e| e.to_string())) {
                Ok(plugin) => Loaded { file, plugin: Some(plugin), error: None },
                Err(e) => Loaded { file, plugin: None, error: Some(e) },
            }
        })
        .collect()
}

/// 数の書き方（画面の model.ts の fillTemplate と同じ）
fn num(v: f64) -> String {
    let r = (v * 1e6).round() / 1e6;
    if r == r.trunc() {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

/// {名前} に数を入れる。フィルターの並びを壊す文字（; [ ]）があるか、入れ残しがあれば None（画面の fillTemplate と同じ）
pub fn fill(template: &str, values: &BTreeMap<String, f64>) -> Option<String> {
    let mut out = template.to_string();
    for (k, v) in values {
        out = out.replace(&format!("{{{k}}}"), &num(*v));
    }
    if out.trim().is_empty() || out.contains(['{', '}', ';', '[', ']']) {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_and_rejects() {
        let v: BTreeMap<String, f64> = [("deg".to_string(), 90.0), ("k".to_string(), 0.25)].into();
        assert_eq!(fill("hue=h={deg}:s={k}", &v).as_deref(), Some("hue=h=90:s=0.25"));
        assert_eq!(fill("hue=h={x}", &v), None);
        assert_eq!(fill("null[a];[a]hue", &v), None);
        let p: Plugin = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(p.effects[0].params[0].default, 90.0);
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("plugins");
        let l = load_dir(&dir);
        assert_eq!(l.len(), 1);
        assert!(l[0].plugin.is_some());
    }
}
