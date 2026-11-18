//! 自動バックアップ：プロジェクトを上書き保存する前に、それまでのファイルを残しておく（プロジェクトごとに新しい順で KEEP 個まで）。
//! 置き場所はアプリのフォルダの「バックアップ」の下に、プロジェクトの場所から決めた名前のフォルダ。

use crate::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 残す数
pub const KEEP: usize = 30;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: PathBuf,
    /// 残した時刻（ミリ秒。この時刻より前に保存した内容）
    pub saved_ms: u64,
    pub size: u64,
}

/// そのプロジェクトのバックアップを置くフォルダ
pub fn dir_for(root: &Path, project: &Path) -> PathBuf {
    let h = Sha256::digest(project.to_string_lossy().as_bytes());
    let key: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let stem = project.file_stem().and_then(|s| s.to_str()).unwrap_or("project");
    // 名前は人が見て分かるように。フォルダ名に使えない文字は _ に
    let safe: String = stem.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).take(40).collect();
    root.join(format!("{safe}_{key}"))
}

/// 新しい順の一覧
pub fn list(root: &Path, project: &Path) -> Vec<BackupEntry> {
    let Ok(rd) = std::fs::read_dir(dir_for(root, project)) else { return vec![] };
    let mut v: Vec<BackupEntry> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let ms: u64 = p.file_stem()?.to_str()?.parse().ok()?;
            (p.extension()? == "voxcut").then(|| BackupEntry { size: e.metadata().map(|m| m.len()).unwrap_or(0), path: p, saved_ms: ms })
        })
        .collect();
    v.sort_by_key(|b| std::cmp::Reverse(b.saved_ms));
    v
}

/// 上書きする前に、今あるファイルを残す（無ければ何もしない。いちばん新しいバックアップと同じ中身なら増やさない）。残したファイルを返す
pub fn before_save(root: &Path, project: &Path, now_ms: u64) -> Result<Option<PathBuf>> {
    let Ok(cur) = std::fs::read(project) else { return Ok(None) };
    let dir = dir_for(root, project);
    let entries = list(root, project);
    if let Some(last) = entries.first() {
        if std::fs::read(&last.path).ok().as_deref() == Some(cur.as_slice()) {
            return Ok(None);
        }
    }
    std::fs::create_dir_all(&dir)?;
    // 同じミリ秒に 2 つ作らない
    let ms = entries.first().map_or(now_ms, |l| now_ms.max(l.saved_ms + 1));
    let dst = dir.join(format!("{ms}.voxcut"));
    std::fs::write(&dst, &cur)?;
    std::fs::write(dir.join("元の場所.txt"), project.to_string_lossy().as_bytes())?;
    for old in list(root, project).into_iter().skip(KEEP) {
        let _ = std::fs::remove_file(old.path);
    }
    Ok(Some(dst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_previous_versions_newest_first() {
        let root = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let proj = work.path().join("動画.voxcut");
        // まだファイルが無ければ残すものは無い
        assert_eq!(before_save(root.path(), &proj, 1).unwrap(), None);
        std::fs::write(&proj, "v1").unwrap();
        let a = before_save(root.path(), &proj, 100).unwrap().unwrap();
        // 中身が変わっていなければ増やさない
        assert_eq!(before_save(root.path(), &proj, 200).unwrap(), None);
        std::fs::write(&proj, "v2").unwrap();
        before_save(root.path(), &proj, 100).unwrap().unwrap();
        let l = list(root.path(), &proj);
        assert_eq!(l.iter().map(|e| e.saved_ms).collect::<Vec<_>>(), vec![101, 100]);
        assert_eq!(std::fs::read_to_string(&l[0].path).unwrap(), "v2");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "v1");
        assert!(dir_for(root.path(), &proj).file_name().unwrap().to_str().unwrap().starts_with("動画_"));
        // 別の場所の同じ名前のプロジェクトとは混ざらない
        assert!(list(root.path(), &work.path().join("x").join("動画.voxcut")).is_empty());
        // KEEP 個まで
        for i in 0..KEEP + 5 {
            std::fs::write(&proj, format!("n{i}")).unwrap();
            before_save(root.path(), &proj, 1000 + i as u64).unwrap();
        }
        let l = list(root.path(), &proj);
        assert_eq!(l.len(), KEEP);
        assert_eq!(std::fs::read_to_string(&l[0].path).unwrap(), format!("n{}", KEEP + 4));
    }
}
