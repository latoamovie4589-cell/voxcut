//! 素材ライブラリ：よく使う画像・動画・効果音・BGM を、プロジェクトをまたいで使えるようにアプリのフォルダへ写しておく。
//! 一覧は library.json（ファイル名はフォルダからの相対）。同じ中身のファイルは 2 つ持たない。

use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const INDEX: &str = "library.json";
const FILES: &str = "files";

const IMAGE: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif"];
const VIDEO: &[&str] = &["mp4", "mov", "mkv", "webm", "avi"];
const AUDIO: &[&str] = &["wav", "mp3", "m4a", "aac", "flac", "ogg"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    /// 見せる名前（はじめはファイル名から拡張子を除いたもの）
    pub name: String,
    /// image / video / audio
    pub kind: String,
    /// 分類（効果音・BGM・立ち絵など。空なら分類なし）
    #[serde(default)]
    pub folder: String,
    /// 保存した中身（一覧ではフォルダからの相対、返すときは絶対パス）
    pub path: PathBuf,
    /// 中身の SHA-256（同じものを 2 つ入れない）
    pub hash: String,
    /// 入れた時刻（ミリ秒）
    pub added_ms: u64,
}

/// 拡張子から素材の種類（対応していなければ None）
pub fn kind_of(p: &Path) -> Option<&'static str> {
    let e = p.extension()?.to_str()?.to_ascii_lowercase();
    if IMAGE.contains(&e.as_str()) {
        Some("image")
    } else if VIDEO.contains(&e.as_str()) {
        Some("video")
    } else if AUDIO.contains(&e.as_str()) {
        Some("audio")
    } else {
        None
    }
}

fn load(dir: &Path) -> Vec<LibraryItem> {
    std::fs::read(dir.join(INDEX)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(dir: &Path, items: &[LibraryItem]) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{INDEX}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(items)?)?;
    std::fs::rename(tmp, dir.join(INDEX))?;
    Ok(())
}

fn absolute(dir: &Path, mut it: LibraryItem) -> LibraryItem {
    it.path = dir.join(&it.path);
    it
}

/// 一覧（ファイルが消えたものは出さない）。新しく入れた順
pub fn list(dir: &Path) -> Vec<LibraryItem> {
    let mut v: Vec<LibraryItem> = load(dir).into_iter().map(|i| absolute(dir, i)).filter(|i| i.path.is_file()).collect();
    v.sort_by(|a, b| b.added_ms.cmp(&a.added_ms).then(a.name.cmp(&b.name)));
    v
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hash_file(p: &Path) -> Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// ファイルを写して入れる。対応していない種類は飛ばす。同じ中身がもうあれば、それを返す（分類だけ空なら埋める）
pub fn add(dir: &Path, srcs: &[PathBuf], folder: &str) -> Result<Vec<LibraryItem>> {
    let mut items = load(dir);
    let files = dir.join(FILES);
    std::fs::create_dir_all(&files)?;
    let mut out = vec![];
    for (n, src) in srcs.iter().enumerate() {
        let Some(kind) = kind_of(src) else { continue };
        if !src.is_file() {
            return Err(crate::Error::Other(format!("「{}」が見つかりません", src.display())));
        }
        let hash = hash_file(src)?;
        if let Some(it) = items.iter_mut().find(|i| i.hash == hash && dir.join(&i.path).is_file()) {
            if it.folder.is_empty() && !folder.is_empty() {
                it.folder = folder.to_string();
            }
            out.push(it.clone());
            continue;
        }
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("素材").to_string();
        let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        // 同じ名前のファイルがあれば番号を付ける
        let mut name = format!("{stem}.{ext}");
        let mut k = 2;
        while files.join(&name).exists() {
            name = format!("{stem} ({k}).{ext}");
            k += 1;
        }
        std::fs::copy(src, files.join(&name))?;
        let t = now_ms();
        let it = LibraryItem { id: format!("lib{t:x}{n}"), name: stem, kind: kind.into(), folder: folder.into(), path: PathBuf::from(FILES).join(&name), hash, added_ms: t + n as u64 };
        items.push(it.clone());
        out.push(it);
    }
    save(dir, &items)?;
    Ok(out.into_iter().map(|i| absolute(dir, i)).collect())
}

/// 名前・分類を変える
pub fn update(dir: &Path, id: &str, name: Option<&str>, folder: Option<&str>) -> Result<()> {
    let mut items = load(dir);
    let Some(it) = items.iter_mut().find(|i| i.id == id) else {
        return Err(crate::Error::Other("ライブラリにありません".into()));
    };
    if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
        it.name = n.to_string();
    }
    if let Some(f) = folder {
        it.folder = f.trim().to_string();
    }
    save(dir, &items)
}

/// ライブラリから外す（写したファイルも消す。プロジェクトで使っていた素材は、そのプロジェクトでは見つからなくなる）
pub fn remove(dir: &Path, id: &str) -> Result<()> {
    let mut items = load(dir);
    if let Some(i) = items.iter().position(|i| i.id == id) {
        let it = items.remove(i);
        let p = dir.join(&it.path);
        if p.starts_with(dir.join(FILES)) {
            let _ = std::fs::remove_file(p);
        }
        save(dir, &items)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_dedupes_renames_and_removes() {
        let src = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let a = src.path().join("ポン.wav");
        let b = src.path().join("sub").join("ポン.wav");
        std::fs::create_dir_all(b.parent().unwrap()).unwrap();
        std::fs::write(&a, b"RIFFaaaa").unwrap();
        std::fs::write(&b, b"RIFFbbbb").unwrap();
        let txt = src.path().join("memo.txt");
        std::fs::write(&txt, b"x").unwrap();
        let got = add(lib.path(), &[a.clone(), b.clone(), txt], "効果音").unwrap();
        assert_eq!(got.len(), 2, "対応していない種類は入れない");
        assert_eq!((got[0].kind.as_str(), got[0].folder.as_str(), got[0].name.as_str()), ("audio", "効果音", "ポン"));
        assert!(got[1].path.ends_with("ポン (2).wav") && got[1].path.is_file(), "同じ名前は番号を付ける {:?}", got[1].path);
        // 同じ中身をもう一度入れても増えない
        let again = add(lib.path(), std::slice::from_ref(&a), "").unwrap();
        assert_eq!((again[0].id.as_str(), list(lib.path()).len()), (got[0].id.as_str(), 2));
        update(lib.path(), &got[0].id, Some("ポン（短い）"), Some("SE")).unwrap();
        let l = list(lib.path());
        let it = l.iter().find(|i| i.id == got[0].id).unwrap();
        assert_eq!((it.name.as_str(), it.folder.as_str()), ("ポン（短い）", "SE"));
        assert!(it.path.is_absolute());
        remove(lib.path(), &got[1].id).unwrap();
        assert_eq!(list(lib.path()).len(), 1);
        assert!(!got[1].path.exists(), "写したファイルも消す");
        assert!(a.exists() && b.exists(), "元のファイルは消さない");
    }
}
