//! 音声合成ジョブ。キャッシュ済みは飛ばし、エンジンごとのキューで処理する。
//! A.I.VOICE と VOICEPEAK は直列、エンジン同士は並列に動く。

use crate::cache::{cache_key, AudioCache};
use crate::model::{AudioRef, EngineId, Project, Voice};
use crate::text::Dictionary;
use crate::tts::{SynthRequest, TtsEngine};
use crate::{Error, Result};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct SynthJob {
    /// 同じ声・同じ本文のクリップはまとめて1回だけ合成する
    pub clip_ids: Vec<String>,
    pub voice: Voice,
    pub text: String,
    pub key: String,
    /// VOICEVOX のアクセントの手直し
    pub accent: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub done: usize,
    pub total: usize,
    pub clip_ids: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct JobResult {
    pub clip_ids: Vec<String>,
    pub result: Result<AudioRef>,
}

/// 合成が必要なジョブと、キャッシュから即座に埋められる結果に分ける
/// `dict` の読み方で置き換えた文を合成する（キャッシュも置き換え後の文で引く）
pub fn plan(p: &Project, cache: &AudioCache, only: Option<&[String]>, dict: &Dictionary) -> (Vec<SynthJob>, Vec<JobResult>) {
    let mut by_key: BTreeMap<String, SynthJob> = BTreeMap::new();
    let mut ready = vec![];
    for c in &p.clips {
        if only.is_some_and(|ids| !ids.contains(&c.id)) {
            continue;
        }
        let Some(v) = c.as_voice() else { continue };
        if v.text.trim().is_empty() {
            continue;
        }
        let Some(voice) = p.effective_voice(v) else { continue };
        let text = dict.apply(&v.text);
        // アクセントの手直しは、作ったときと文・話者が同じ VOICEVOX の行でだけ使う。キャッシュの鍵にも入れる
        let accent = v
            .accent
            .as_ref()
            .filter(|a| voice.engine == crate::model::EngineId::Voicevox && a.text == text && a.speaker == voice.speaker)
            .map(|a| a.phrases.clone());
        let key = match &accent {
            Some(a) => cache_key(&voice, &format!("{text}\u{1}accent:{a}")),
            None => cache_key(&voice, &text),
        };
        if let Some(path) = cache.get(&key) {
            ready.push(JobResult {
                clip_ids: vec![c.id.clone()],
                result: crate::wav::duration_ms(&path).map(|ms| AudioRef { cache_key: key, duration_ms: ms }),
            });
            continue;
        }
        by_key
            .entry(key.clone())
            .and_modify(|j| j.clip_ids.push(c.id.clone()))
            .or_insert(SynthJob { clip_ids: vec![c.id.clone()], voice, text, key, accent });
    }
    (by_key.into_values().collect(), ready)
}

fn synth_one(engine: &dyn TtsEngine, cache: &AudioCache, job: &SynthJob) -> Result<AudioRef> {
    let (tmp, fin) = cache.prepare(&job.key)?;
    let req = SynthRequest { speaker: &job.voice.speaker, text: &job.text, params: &job.voice.params, accent: job.accent.as_ref() };
    let r = engine.synthesize(&req, &tmp).and_then(|_| {
        let ms = crate::wav::duration_ms(&tmp)?;
        cache.commit(&tmp, &fin)?;
        Ok(AudioRef { cache_key: job.key.clone(), duration_ms: ms })
    });
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

/// ジョブを実行する。`on_progress` は1件終わるごとに呼ばれる（どのスレッドからでも）。
pub fn run(
    jobs: Vec<SynthJob>,
    engines: &[Arc<dyn TtsEngine>],
    cache: &AudioCache,
    on_progress: &(dyn Fn(JobProgress) + Sync),
) -> Vec<JobResult> {
    let total = jobs.len();
    let mut queues: HashMap<EngineId, VecDeque<SynthJob>> = HashMap::new();
    for j in jobs {
        queues.entry(j.voice.engine).or_default().push_back(j);
    }
    let done = Mutex::new(0usize);
    let results = Mutex::new(Vec::with_capacity(total));
    std::thread::scope(|s| {
        for (eid, q) in queues {
            let engine = engines.iter().find(|e| e.id() == eid).cloned();
            let q = Arc::new(Mutex::new(q));
            let workers = engine.as_ref().map(|e| e.max_concurrency().max(1)).unwrap_or(1);
            for _ in 0..workers {
                let (q, engine, done, results) = (q.clone(), engine.clone(), &done, &results);
                s.spawn(move || loop {
                    let Some(job) = q.lock().unwrap().pop_front() else { break };
                    let result = match &engine {
                        Some(e) => synth_one(e.as_ref(), cache, &job),
                        None => Err(Error::EngineNotFound { engine: "音声合成", detail: format!("{} は使えません", eid.as_str()) }),
                    };
                    let n = {
                        let mut d = done.lock().unwrap();
                        *d += 1;
                        *d
                    };
                    on_progress(JobProgress {
                        done: n,
                        total,
                        clip_ids: job.clip_ids.clone(),
                        error: result.as_ref().err().map(|e| e.to_string()),
                    });
                    results.lock().unwrap().push(JobResult { clip_ids: job.clip_ids, result });
                });
            }
        }
    });
    results.into_inner().unwrap()
}

/// 結果をプロジェクトに反映し、セリフトラックを詰め直す。失敗したクリップ ID とエラーを返す。
pub fn apply(p: &mut Project, results: Vec<JobResult>) -> Vec<(String, String)> {
    let mut failed = vec![];
    for r in results {
        match r.result {
            Ok(a) => {
                for id in &r.clip_ids {
                    if let Some(v) = p.clips.iter_mut().find(|c| &c.id == id).and_then(|c| c.as_voice_mut()) {
                        v.audio = Some(a.clone());
                    }
                }
            }
            Err(e) => failed.extend(r.clip_ids.into_iter().map(|id| (id, e.to_string()))),
        }
    }
    p.reflow_all();
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::{EngineStatus, VoiceInfo};
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeEngine {
        id: EngineId,
        calls: AtomicUsize,
        running: AtomicUsize,
        max_seen: AtomicUsize,
    }

    impl FakeEngine {
        fn new(id: EngineId) -> Arc<Self> {
            Arc::new(Self { id, calls: 0.into(), running: 0.into(), max_seen: 0.into() })
        }
    }

    impl TtsEngine for FakeEngine {
        fn id(&self) -> EngineId {
            self.id
        }
        fn status(&self) -> EngineStatus {
            EngineStatus::Ready { version: None }
        }
        fn list_voices(&self) -> Result<Vec<VoiceInfo>> {
            Ok(vec![])
        }
        fn synthesize(&self, req: &SynthRequest<'_>, out: &Path) -> Result<()> {
            let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_seen.fetch_max(now, Ordering::SeqCst);
            self.calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(20));
            // 文字数 × 100ms の音声
            crate::wav::write_tone(out, 24000, req.text.chars().count() as u32 * 100, 440.0);
            self.running.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn plans_dedupes_runs_and_uses_cache() {
        let d = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(d.path());
        let mut p = Project::sample();
        // 同じ声・同じ本文を2つにする → 合成は1回
        p.clips[2].as_voice_mut().unwrap().text = p.clips[0].as_voice().unwrap().text.clone();
        let vp = FakeEngine::new(EngineId::Voicepeak);
        let ai = FakeEngine::new(EngineId::Aivoice);
        let engines: Vec<Arc<dyn TtsEngine>> = vec![vp.clone(), ai.clone()];

        let (jobs, ready) = plan(&p, &cache, None, &Dictionary::default());
        assert_eq!(jobs.len(), 2);
        assert!(ready.is_empty());
        let progress = Mutex::new(vec![]);
        let res = run(jobs, &engines, &cache, &|pr| progress.lock().unwrap().push(pr.done));
        assert_eq!(progress.lock().unwrap().len(), 2);
        let failed = apply(&mut p, res);
        assert!(failed.is_empty());
        assert_eq!(vp.calls.load(Ordering::SeqCst), 1);
        assert_eq!(ai.calls.load(Ordering::SeqCst), 1);
        // 長さ = 音声（"こんにちは。VoxCut のサンプルです。" = 21 文字 → 2.1 秒 = 63 フレーム）+ 余韻 6
        assert_eq!(p.clips[0].duration, 63 + 6);
        // 会話の並び（別のレイヤーでも、すぐ後ろのセリフ）は付いていく
        assert_eq!(p.clips[1].start, 69);
        assert_eq!(p.clips[2].start, p.clips[1].start + p.clips[1].duration);

        // 2回目は全部キャッシュから
        let (jobs, ready) = plan(&p, &cache, None, &Dictionary::default());
        assert!(jobs.is_empty());
        assert_eq!(ready.len(), 3);
    }

    #[test]
    fn serial_engine_never_overlaps() {
        let d = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(d.path());
        let mut p = Project::sample();
        for c in p.clips.iter_mut().filter_map(|c| c.as_voice_mut()) {
            c.character_id = "ch_a".into(); // 全部 VOICEPEAK
        }
        let vp = FakeEngine::new(EngineId::Voicepeak);
        let engines: Vec<Arc<dyn TtsEngine>> = vec![vp.clone()];
        let (jobs, _) = plan(&p, &cache, None, &Dictionary::default());
        run(jobs, &engines, &cache, &|_| {});
        assert_eq!(vp.calls.load(Ordering::SeqCst), 3);
        assert_eq!(vp.max_seen.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_engine_reports_error() {
        let d = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(d.path());
        let mut p = Project::sample();
        let (jobs, _) = plan(&p, &cache, None, &Dictionary::default());
        let res = run(jobs, &[], &cache, &|_| {});
        let failed = apply(&mut p, res);
        assert_eq!(failed.len(), 3);
    }

    #[test]
    fn dictionary_and_speaker_override_change_the_job() {
        let d = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(d.path());
        let mut p = Project::sample();
        let dict = Dictionary::new(&[crate::text::DictEntry { word: "VoxCut".into(), reading: "ボックスカット".into() }]);
        let (jobs, _) = plan(&p, &cache, Some(&["c1".to_string()]), &dict);
        assert_eq!(jobs[0].text, "こんにちは。ボックスカット のサンプルです。");
        let (plain, _) = plan(&p, &cache, Some(&["c1".to_string()]), &Dictionary::default());
        assert_ne!(jobs[0].key, plain[0].key, "読みが変われば別の音声として合成し直す");
        p.clips[0].as_voice_mut().unwrap().speaker_override = Some("Japanese Male 1".into());
        let (jobs, _) = plan(&p, &cache, Some(&["c1".to_string()]), &Dictionary::default());
        assert_eq!(jobs[0].voice.speaker, "Japanese Male 1");
    }

    #[test]
    fn accent_edit_used_only_when_text_and_speaker_match() {
        use crate::model::{AccentEdit, ClipBody, EngineId};
        let mut p = Project::sample();
        p.characters[0].voice.engine = EngineId::Voicevox;
        p.characters[0].voice.speaker = "3".into();
        let d = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(d.path());
        let (jobs0, _) = plan(&p, &cache, Some(&["c1".to_string()]), &Dictionary::default());
        let phrases = serde_json::json!([{"accent": 2}]);
        if let ClipBody::Voice(v) = &mut p.clips[0].body {
            v.accent = Some(AccentEdit { text: v.text.clone(), speaker: "3".into(), phrases: phrases.clone() });
        }
        let (jobs1, _) = plan(&p, &cache, Some(&["c1".to_string()]), &Dictionary::default());
        assert_eq!(jobs1[0].accent.as_ref(), Some(&phrases));
        assert_ne!(jobs0[0].key, jobs1[0].key, "アクセントを変えたら合成し直す");
        // 文が変わったら使わない
        if let ClipBody::Voice(v) = &mut p.clips[0].body {
            v.text.push('！');
        }
        let (jobs2, _) = plan(&p, &cache, Some(&["c1".to_string()]), &Dictionary::default());
        assert!(jobs2[0].accent.is_none());
    }
}
