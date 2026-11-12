//! 音声合成ジョブ。キャッシュ済みは飛ばし、エンジンごとのキューで処理する。
//! A.I.VOICE と VOICEPEAK は直列、エンジン同士は並列に動く。

use crate::cache::{cache_key, AudioCache};
use crate::model::{AudioRef, EngineId, Project, TrackKind, Voice};
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
pub fn plan(p: &Project, cache: &AudioCache, only: Option<&[String]>) -> (Vec<SynthJob>, Vec<JobResult>) {
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
        let key = cache_key(&voice, &v.text);
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
            .or_insert(SynthJob { clip_ids: vec![c.id.clone()], voice, text: v.text.clone(), key });
    }
    (by_key.into_values().collect(), ready)
}

fn synth_one(engine: &dyn TtsEngine, cache: &AudioCache, job: &SynthJob) -> Result<AudioRef> {
    let (tmp, fin) = cache.prepare(&job.key)?;
    let req = SynthRequest { speaker: &job.voice.speaker, text: &job.text, params: &job.voice.params };
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
    let voice_tracks: Vec<String> = p.tracks.iter().filter(|t| t.kind == TrackKind::Voice).map(|t| t.id.clone()).collect();
    for t in voice_tracks {
        p.reflow_voice_track(&t);
    }
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

        let (jobs, ready) = plan(&p, &cache, None);
        assert_eq!(jobs.len(), 2);
        assert!(ready.is_empty());
        let progress = Mutex::new(vec![]);
        let res = run(jobs, &engines, &cache, &|pr| progress.lock().unwrap().push(pr.done));
        assert_eq!(progress.lock().unwrap().len(), 2);
        let failed = apply(&mut p, res);
        assert!(failed.is_empty());
        assert_eq!(vp.calls.load(Ordering::SeqCst), 1);
        assert_eq!(ai.calls.load(Ordering::SeqCst), 1);
        // 音声長に合わせて詰め直されている（"こんにちは。VoxCut のサンプルです。" = 21 文字 → 2.1 秒 = 63 フレーム）
        assert_eq!(p.clips[0].duration, 63);
        assert_eq!(p.clips[1].start, 63 + 6);

        // 2回目は全部キャッシュから
        let (jobs, ready) = plan(&p, &cache, None);
        assert!(jobs.is_empty());
        assert_eq!(ready.len(), 3);
    }

    #[test]
    fn serial_engine_never_overlaps() {
        let d = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(d.path());
        let mut p = Project::sample();
        for c in &mut p.clips {
            c.as_voice_mut().unwrap().character_id = "ch_a".into(); // 全部 VOICEPEAK
        }
        let vp = FakeEngine::new(EngineId::Voicepeak);
        let engines: Vec<Arc<dyn TtsEngine>> = vec![vp.clone()];
        let (jobs, _) = plan(&p, &cache, None);
        run(jobs, &engines, &cache, &|_| {});
        assert_eq!(vp.calls.load(Ordering::SeqCst), 3);
        assert_eq!(vp.max_seen.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_engine_reports_error() {
        let d = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(d.path());
        let mut p = Project::sample();
        let (jobs, _) = plan(&p, &cache, None);
        let res = run(jobs, &[], &cache, &|_| {});
        let failed = apply(&mut p, res);
        assert_eq!(failed.len(), 3);
    }
}
