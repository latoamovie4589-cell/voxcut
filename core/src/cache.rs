//! 合成済み音声のキャッシュ。
//! キー = sha256(キャッシュ形式の版 | エンジン | 話者 | パラメータ(正規化JSON) | 本文)

use crate::model::Voice;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// キーの作り方を変えたら上げる（古いキャッシュを自然に無効化する）
const CACHE_FORMAT: &str = "v1";

pub fn cache_key(voice: &Voice, text: &str) -> String {
    // VoiceParams.emotions は BTreeMap なので、serde_json の出力順は常に同じ
    let params = serde_json::to_string(&voice.params).expect("VoiceParams は必ず JSON にできる");
    let mut h = Sha256::new();
    for part in [CACHE_FORMAT, voice.engine.as_str(), &voice.speaker, &params, text] {
        h.update((part.len() as u64).to_le_bytes()); // 区切りの曖昧さを防ぐ
        h.update(part.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone)]
pub struct AudioCache {
    root: PathBuf,
}

impl AudioCache {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path_for(&self, key: &str) -> PathBuf {
        let shard = &key[..2.min(key.len())];
        self.root.join(shard).join(format!("{key}.wav"))
    }

    pub fn get(&self, key: &str) -> Option<PathBuf> {
        let p = self.path_for(key);
        p.is_file().then_some(p)
    }

    /// 書き込み先を用意する。エンジンには一時ファイルに書かせ、成功したら `commit` で確定させる。
    pub fn prepare(&self, key: &str) -> std::io::Result<(PathBuf, PathBuf)> {
        let final_path = self.path_for(key);
        std::fs::create_dir_all(final_path.parent().unwrap())?;
        let tmp = final_path.with_extension(format!("{}.tmp.wav", std::process::id()));
        Ok((tmp, final_path))
    }

    pub fn commit(&self, tmp: &Path, final_path: &Path) -> std::io::Result<()> {
        std::fs::rename(tmp, final_path)
    }

    /// 使われていないキャッシュを消す。戻り値は消したファイル数。
    pub fn prune(&self, keep: &std::collections::HashSet<String>) -> std::io::Result<usize> {
        let mut removed = 0;
        let Ok(shards) = std::fs::read_dir(&self.root) else { return Ok(0) };
        for shard in shards.flatten() {
            let Ok(files) = std::fs::read_dir(shard.path()) else { continue };
            for f in files.flatten() {
                let path = f.path();
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if !keep.contains(stem) {
                    std::fs::remove_file(&path)?;
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EngineId, VoiceParams};

    fn voice() -> Voice {
        Voice { engine: EngineId::Voicepeak, speaker: "Japanese Female 1".into(), params: VoiceParams::default() }
    }

    #[test]
    fn key_is_stable_and_sensitive() {
        let v = voice();
        let k1 = cache_key(&v, "こんにちは");
        assert_eq!(k1, cache_key(&v, "こんにちは"));
        assert_eq!(k1.len(), 64);
        assert_ne!(k1, cache_key(&v, "こんばんは"));
        let mut v2 = v.clone();
        v2.params.speed = 1.1;
        assert_ne!(k1, cache_key(&v2, "こんにちは"));
        let mut v3 = v.clone();
        v3.engine = EngineId::Voisona;
        assert_ne!(k1, cache_key(&v3, "こんにちは"));
    }

    #[test]
    fn emotion_order_does_not_matter() {
        let mut a = voice();
        a.params.emotions.insert("happy".into(), 10.0);
        a.params.emotions.insert("sad".into(), 5.0);
        let mut b = voice();
        b.params.emotions.insert("sad".into(), 5.0);
        b.params.emotions.insert("happy".into(), 10.0);
        assert_eq!(cache_key(&a, "x"), cache_key(&b, "x"));
    }

    #[test]
    fn prepare_commit_prune() {
        let d = tempfile::tempdir().unwrap();
        let c = AudioCache::new(d.path());
        let key = cache_key(&voice(), "テスト");
        assert!(c.get(&key).is_none());
        let (tmp, fin) = c.prepare(&key).unwrap();
        std::fs::write(&tmp, b"x").unwrap();
        c.commit(&tmp, &fin).unwrap();
        assert_eq!(c.get(&key).unwrap(), fin);
        assert_eq!(c.prune(&[key.clone()].into_iter().collect()).unwrap(), 0);
        assert_eq!(c.prune(&Default::default()).unwrap(), 1);
        assert!(c.get(&key).is_none());
    }
}
