//! FFmpeg での書き出し。引数の組み立て（テスト可能な純粋関数）と、実行・進捗の読み取り。

use crate::lipsync;
use crate::model::{ClipBody, MediaKind, Project, Transform};
use crate::{Error, Result};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub ffmpeg: PathBuf,
    pub out: PathBuf,
    /// プロジェクトファイルのあるフォルダ（素材の相対パスの基準）
    pub project_dir: PathBuf,
    pub crf: u8,
    /// x264 の preset。速さ優先で veryfast を既定にする
    pub preset: String,
    /// 出力の高さ（None ならプロジェクトの大きさのまま）。字幕は元の大きさで描いてから縮める
    pub out_height: Option<u32>,
}

impl ExportOptions {
    pub fn new(ffmpeg: impl Into<PathBuf>, out: impl Into<PathBuf>, project_dir: impl Into<PathBuf>) -> Self {
        Self { ffmpeg: ffmpeg.into(), out: out.into(), project_dir: project_dir.into(), crf: 20, preset: "veryfast".into(), out_height: None }
    }
}

/// FFmpeg のフィルタ引数の中に書くパス（Windows の "C:\..." の ":" と "\" を逃がす）
pub fn escape_filter_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    format!("'{}'", s.replace(':', "\\:").replace('\'', "\\'"))
}

fn hex_color(c: &str) -> String {
    format!("0x{}", c.trim_start_matches('#'))
}

/// 立ち絵 1 人分の入力（状態ごとの画像を並べた ffconcat と、置き方）
#[derive(Debug, Clone)]
pub struct PortraitInput {
    pub concat: PathBuf,
    pub transform: Transform,
}

fn concat_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"))
}

/// 立ち絵の書き出し準備。キャラクターごとに
/// 1) フレームごとの状態（口パク・目パチ）を計算し
/// 2) 使う状態の組み合わせだけ画像を合成し（FFmpeg で重ねて PNG に）
/// 3) 「この画像を何秒」の並びを ffconcat に書く。
///
/// 書き出し時はこれを 1 本の映像として重ねるので、フレームごとの切り替えでもフィルタが増えない。
pub fn prepare_portraits(
    p: &Project,
    project_dir: &Path,
    ffmpeg: &Path,
    work: &Path,
    peaks_for: &dyn Fn(&str) -> Option<Vec<i8>>,
) -> Result<Vec<PortraitInput>> {
    let total = p.duration();
    let fps = p.video.fps as f64;
    let mut out = vec![];
    for (ci, ch) in p.characters.iter().enumerate() {
        let Some(pt) = ch.portrait.as_ref().filter(|pt| pt.visible && !pt.base.is_empty()) else { continue };
        let states = lipsync::portrait_track(p, ch, total, peaks_for);
        let runs = lipsync::runs(&states);
        let mut images: std::collections::HashMap<usize, PathBuf> = Default::default();
        for (st, _) in &runs {
            if images.contains_key(&st.index()) {
                continue;
            }
            let layers: Vec<String> = pt.layers(st.eyes as usize, st.mouth as usize).into_iter().map(|l| resolve(project_dir, l)).collect();
            let img = if layers.len() == 1 {
                PathBuf::from(&layers[0])
            } else {
                let dst = work.join(format!("portrait{ci}_{}.png", st.index()));
                compose_layers(ffmpeg, &layers, &dst)?;
                dst
            };
            images.insert(st.index(), img);
        }
        let mut list = String::from("ffconcat version 1.0\n");
        for (st, n) in &runs {
            list.push_str(&format!("file {}\nduration {:.6}\n", concat_quote(&images[&st.index()]), *n as f64 / fps));
        }
        // concat demuxer は最後の duration を無視するので、最後の画像をもう一度書く
        if let Some((st, _)) = runs.last() {
            list.push_str(&format!("file {}\n", concat_quote(&images[&st.index()])));
        }
        let concat = work.join(format!("portrait{ci}.ffconcat"));
        std::fs::write(&concat, list)?;
        out.push(PortraitInput { concat, transform: pt.transform.clone() });
    }
    Ok(out)
}

/// 同じ大きさの透過 PNG を重ねて 1 枚にする
pub fn compose_layers(ffmpeg: &Path, layers: &[String], dst: &Path) -> Result<()> {
    let mut cmd = crate::tts::hidden_command(ffmpeg);
    cmd.args(["-hide_banner", "-v", "error", "-y"]);
    for l in layers {
        cmd.arg("-i").arg(l);
    }
    let mut fc = String::new();
    let mut last = "0:v".to_string();
    for i in 1..layers.len() {
        let o = format!("l{i}");
        fc.push_str(&format!("[{last}][{i}:v]overlay=0:0:format=auto[{o}];"));
        last = o;
    }
    fc.push_str(&format!("[{last}]format=rgba[out]"));
    let out = cmd.args(["-filter_complex", &fc, "-map", "[out]", "-frames:v", "1"]).arg(dst).output()?;
    if !out.status.success() {
        return Err(Error::Ffmpeg(format!("立ち絵を合成できません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(())
}

/// 書き出しに使う FFmpeg の引数を組み立てる。
/// `voice_wav` はクリップ ID → 合成済み WAV のパス。`ass` は字幕ファイル。
pub fn build_args(
    p: &Project,
    voice_wav: &dyn Fn(&str) -> Option<PathBuf>,
    portraits: &[PortraitInput],
    ass: Option<&Path>,
    opt: &ExportOptions,
) -> Result<Vec<String>> {
    let v = &p.video;
    let total = p.duration().max(1);
    let total_s = v.frames_to_secs(total);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];
    let push_input = |args: &mut Vec<String>, pre: Vec<String>, path: String| {
        args.extend(pre);
        args.push("-i".into());
        args.push(path);
    };
    // 入力 0：背景
    push_input(
        &mut args,
        vec!["-f".into(), "lavfi".into()],
        format!("color=c={}:s={}x{}:r={}:d={:.3}", hex_color(&v.background), v.width, v.height, v.fps, total_s),
    );
    let mut idx = 1usize;
    let mut fc: Vec<String> = vec![];
    let mut audio_labels: Vec<String> = vec![];
    let mut last_v = "0:v".to_string();

    // 配列の先頭（画面で上）のトラックほど手前に描くので、逆順に重ねる
    for track in p.tracks.iter().rev() {
        if track.muted {
            continue;
        }
        let mut clips: Vec<_> = p.clips.iter().filter(|c| c.track_id == track.id).collect();
        clips.sort_by_key(|c| c.start);
        for c in clips {
            let start = v.frames_to_secs(c.start);
            let dur = v.frames_to_secs(c.duration);
            let delay_ms = (start * 1000.0).round() as u64;
            match &c.body {
                ClipBody::Voice(vc) => {
                    let Some(wav) = voice_wav(&c.id) else {
                        return Err(Error::Other(format!("クリップ {} の音声がまだ合成されていません", c.id)));
                    };
                    let vol = p.character(&vc.character_id).map(|ch| ch.voice.params.volume).unwrap_or(1.0);
                    push_input(&mut args, vec![], wav.to_string_lossy().into_owned());
                    let l = format!("a{idx}");
                    fc.push(format!("[{idx}:a]aresample={},atrim=0:{dur:.3},adelay=delays={delay_ms}:all=1,volume={vol:.3}[{l}]", v.sample_rate));
                    audio_labels.push(l);
                    idx += 1;
                }
                ClipBody::Media(m) => {
                    let src = resolve(&opt.project_dir, &m.src);
                    let in_s = v.frames_to_secs(m.in_point);
                    match m.media_kind {
                        MediaKind::Audio => {
                            push_input(&mut args, vec!["-ss".into(), format!("{in_s:.3}"), "-t".into(), format!("{dur:.3}")], src);
                            let l = format!("a{idx}");
                            fc.push(format!("[{idx}:a]aresample={},adelay=delays={delay_ms}:all=1,volume={:.3}[{l}]", v.sample_rate, m.volume));
                            audio_labels.push(l);
                        }
                        MediaKind::Image | MediaKind::Video => {
                            let pre = if m.media_kind == MediaKind::Image {
                                vec!["-loop".into(), "1".into(), "-framerate".into(), v.fps.to_string(), "-t".into(), format!("{dur:.3}")]
                            } else {
                                vec!["-ss".into(), format!("{in_s:.3}"), "-t".into(), format!("{dur:.3}")]
                            };
                            push_input(&mut args, pre, src);
                            // 動画の音声
                            if m.media_kind == MediaKind::Video && m.has_audio {
                                let l = format!("a{idx}");
                                fc.push(format!("[{idx}:a]aresample={},adelay=delays={delay_ms}:all=1,volume={:.3}[{l}]", v.sample_rate, m.volume));
                                audio_labels.push(l);
                            }
                            let t = &m.transform;
                            let src_l = format!("v{idx}");
                            fc.push(format!(
                                "[{idx}:v]fps={},scale=iw*{s:.4}:ih*{s:.4},format=rgba,colorchannelmixer=aa={o:.3},setpts=PTS-STARTPTS+{start:.3}/TB[{src_l}]",
                                v.fps,
                                s = t.scale,
                                o = t.opacity.clamp(0.0, 1.0)
                            ));
                            let out_l = format!("ov{idx}");
                            fc.push(format!(
                                "[{last_v}][{src_l}]overlay=x=(W-w)/2+{x:.1}:y=(H-h)/2+{y:.1}:enable='between(t,{start:.3},{end:.3})':eof_action=pass[{out_l}]",
                                x = t.x,
                                y = t.y,
                                end = start + dur
                            ));
                            last_v = out_l;
                        }
                    }
                    idx += 1;
                }
            }
        }
    }

    // 立ち絵（素材より手前、字幕より奥）
    for pi in portraits {
        push_input(&mut args, vec!["-f".into(), "concat".into(), "-safe".into(), "0".into()], pi.concat.to_string_lossy().into_owned());
        let t = &pi.transform;
        let src_l = format!("p{idx}");
        fc.push(format!(
            "[{idx}:v]fps={},scale=iw*{s:.4}:ih*{s:.4},format=rgba,colorchannelmixer=aa={o:.3}[{src_l}]",
            v.fps,
            s = t.scale,
            o = t.opacity.clamp(0.0, 1.0)
        ));
        let out_l = format!("ov{idx}");
        fc.push(format!("[{last_v}][{src_l}]overlay=x=(W-w)/2+{x:.1}:y=(H-h)/2+{y:.1}:eof_action=pass[{out_l}]", x = t.x, y = t.y));
        last_v = out_l;
        idx += 1;
    }

    // 字幕 → 出力の大きさ
    let resize = match opt.out_height {
        Some(oh) if oh != v.height => format!(",scale=-2:{oh}:flags=lanczos"),
        _ => String::new(),
    };
    if let Some(a) = ass {
        fc.push(format!("[{last_v}]ass={}{resize}[vout]", escape_filter_path(a)));
    } else {
        fc.push(format!("[{last_v}]null{resize}[vout]"));
    }
    // 音声（なければ無音）
    if audio_labels.is_empty() {
        fc.push(format!("anullsrc=r={}:cl=stereo,atrim=0:{total_s:.3}[aout]", v.sample_rate));
    } else {
        let ins: String = audio_labels.iter().map(|l| format!("[{l}]")).collect();
        fc.push(format!("{ins}amix=inputs={}:normalize=0:duration=longest,apad,atrim=0:{total_s:.3}[aout]", audio_labels.len()));
    }

    args.extend([
        "-filter_complex".into(),
        fc.join(";"),
        "-map".into(),
        "[vout]".into(),
        "-map".into(),
        "[aout]".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        opt.preset.clone(),
        "-crf".into(),
        opt.crf.to_string(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-r".into(),
        v.fps.to_string(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-t".into(),
        format!("{total_s:.3}"),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        opt.out.to_string_lossy().into_owned(),
    ]);
    Ok(args)
}

fn resolve(base: &Path, src: &str) -> String {
    let p = Path::new(src);
    if p.is_absolute() { p.to_path_buf() } else { base.join(p) }.to_string_lossy().into_owned()
}

/// 書き出しを実行する。`on_progress` には 0.0〜1.0 が渡る。
pub fn run(args: &[String], ffmpeg: &Path, total_secs: f64, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    run_cancellable(args, ffmpeg, total_secs, on_progress, None)
}

/// `cancel` が立ったら FFmpeg を止めて `Error::Cancelled` を返す（書きかけのファイルは消す）
pub fn run_cancellable(
    args: &[String],
    ffmpeg: &Path,
    total_secs: f64,
    on_progress: &mut dyn FnMut(f64),
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<()> {
    let mut child = crate::tts::hidden_command(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Ffmpeg(format!("FFmpeg を起動できません（{}）: {e}", ffmpeg.display())))?;
    // stderr はエラー表示用に別スレッドで溜める（パイプが詰まらないように）
    let stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut tail: std::collections::VecDeque<String> = Default::default();
        for l in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            if tail.len() >= 20 {
                tail.pop_front();
            }
            tail.push_back(l);
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });
    let is_cancelled = || cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed));
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(std::result::Result::ok) {
        if is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = err_thread.join();
            if let Some(out) = args.last() {
                let _ = std::fs::remove_file(out);
            }
            return Err(Error::Cancelled);
        }
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|s| s.trim().parse::<f64>().ok()) {
            on_progress((us / 1e6 / total_secs.max(0.001)).clamp(0.0, 1.0));
        } else if line.trim() == "progress=end" {
            on_progress(1.0);
        }
    }
    let status = child.wait()?;
    let err = err_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(Error::Ffmpeg(err));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn with_media(mut p: Project) -> Project {
        p.clips.push(Clip {
            id: "m1".into(),
            track_id: "t_media".into(),
            start: 0,
            duration: 270,
            body: ClipBody::Media(MediaClip {
                src: "bg.png".into(),
                media_kind: MediaKind::Image,
                has_audio: false,
                in_point: 0,
                volume: 1.0,
                transform: Transform { scale: 0.5, ..Default::default() },
            }),
        });
        p
    }

    #[test]
    fn escape_windows_path() {
        assert_eq!(escape_filter_path(Path::new(r"C:\Users\me\sub.ass")), r"'C\:/Users/me/sub.ass'");
    }

    #[test]
    fn args_contain_expected_graph() {
        let p = with_media(Project::sample());
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        let args = build_args(&p, &|id| Some(PathBuf::from(format!("/cache/{id}.wav"))), &[], Some(Path::new("/tmp/s.ass")), &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("adelay=delays=3000:all=1"), "{fc}");
        assert!(fc.contains("amix=inputs=3"));
        assert!(fc.contains("overlay=x=(W-w)/2+0.0"));
        assert!(fc.contains("ass='/tmp/s.ass'[vout]"));
        assert!(args.contains(&"/proj/bg.png".to_string()));
        // 背景の長さ＝最後のクリップの終わり（270 フレーム = 9 秒）
        assert!(args.iter().any(|a| a.ends_with(":d=9.000")));
    }

    #[test]
    fn video_audio_is_mixed_only_when_present() {
        let mut p = Project::sample();
        p.clips.push(Clip {
            id: "v1".into(),
            track_id: "t_media".into(),
            start: 30,
            duration: 60,
            body: ClipBody::Media(MediaClip {
                src: "/m/a.mp4".into(),
                media_kind: MediaKind::Video,
                has_audio: true,
                in_point: 15,
                volume: 0.5,
                transform: Transform::default(),
            }),
        });
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        let wav = |id: &str| Some(PathBuf::from(format!("/c/{id}.wav")));
        let args = build_args(&p, &wav, &[], None, &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("amix=inputs=4"), "{fc}");
        assert!(fc.contains("adelay=delays=1000:all=1,volume=0.500"));
        // 切り出し位置 15 フレーム = 0.5 秒
        let i = args.iter().position(|a| a == "/m/a.mp4").unwrap();
        assert_eq!(&args[i - 5..i - 1], &["-ss", "0.500", "-t", "2.000"]);

        if let ClipBody::Media(m) = &mut p.clips.last_mut().unwrap().body {
            m.has_audio = false;
        }
        let args = build_args(&p, &wav, &[], None, &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("amix=inputs=3"));
    }

    #[test]
    fn output_height_scales_after_subtitles() {
        let p = Project::sample();
        let mut opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        opt.out_height = Some(720);
        let wav = |id: &str| Some(PathBuf::from(format!("/c/{id}.wav")));
        let args = build_args(&p, &wav, &[], Some(Path::new("/s.ass")), &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("ass='/s.ass',scale=-2:720:flags=lanczos[vout]"), "{fc}");
        opt.out_height = Some(1080); // 同じ高さなら縮めない
        let args = build_args(&p, &wav, &[], Some(Path::new("/s.ass")), &opt).unwrap();
        assert!(!args.iter().any(|a| a.contains("scale=-2")));
    }

    #[test]
    fn cancel_stops_ffmpeg_and_removes_output() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("long.mp4");
        // 長い映像を作らせ、最初の進捗で取り消す
        let args: Vec<String> = ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=120", "-c:v", "libx264", "-preset", "veryslow", "-progress", "pipe:1", "-nostats"]
            .iter()
            .map(|s| s.to_string())
            .chain([out.to_string_lossy().into_owned()])
            .collect();
        let flag = std::sync::atomic::AtomicBool::new(false);
        let t = std::time::Instant::now();
        let r = run_cancellable(&args, Path::new("ffmpeg"), 120.0, &mut |_| flag.store(true, std::sync::atomic::Ordering::Relaxed), Some(&flag));
        assert!(matches!(r, Err(Error::Cancelled)), "{r:?}");
        assert!(t.elapsed().as_secs() < 30);
        assert!(!out.exists());
    }

    #[test]
    fn missing_voice_is_an_error() {
        let p = Project::sample();
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        assert!(build_args(&p, &|_| None, &[], None, &opt).is_err());
    }

    /// 実際に FFmpeg で書き出す（FFmpeg が入っている環境だけ）
    #[test]
    fn renders_real_file_when_ffmpeg_available() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            eprintln!("ffmpeg がないので省略");
            return;
        }
        let d = tempfile::tempdir().unwrap();
        // 素材画像
        let st = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "color=c=0x336699:s=320x180", "-frames:v", "1"])
            .arg(d.path().join("bg.png"))
            .status()
            .unwrap();
        assert!(st.success());
        let mut p = with_media(Project::sample());
        p.video.width = 640;
        p.video.height = 360;
        for (i, c) in p.clips.iter_mut().filter(|c| c.as_voice().is_some()).enumerate() {
            let w = d.path().join(format!("{}.wav", c.id));
            crate::wav::write_tone(&w, 24000, 800 + i as u32 * 200, 300.0 + i as f32 * 100.0);
            c.as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: c.id.clone(), duration_ms: 0 });
        }
        // 立ち絵（体・目・口の 3 層。目と口は状態ごとに色を変えて、合成されたか確かめる）
        let mk = |name: &str, filter: &str| {
            let st = std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-f", "lavfi", "-i", "color=c=black@0.0:s=200x300,format=rgba"])
                .args(["-vf", filter, "-frames:v", "1"])
                .arg(d.path().join(name))
                .status()
                .unwrap();
            assert!(st.success());
        };
        mk("body.png", "drawbox=x=40:y=40:w=120:h=240:color=0xff9f0a@1:t=fill");
        mk("eye0.png", "drawbox=x=70:y=90:w=60:h=10:color=white@1:t=fill");
        mk("eye2.png", "drawbox=x=70:y=95:w=60:h=2:color=white@1:t=fill");
        mk("mouth0.png", "drawbox=x=90:y=140:w=20:h=3:color=red@1:t=fill");
        mk("mouth2.png", "drawbox=x=85:y=135:w=30:h=20:color=red@1:t=fill");
        p.characters[0].portrait = Some(Portrait {
            base: "body.png".into(),
            eyes: [Some("eye0.png".into()), None, Some("eye2.png".into())],
            mouth: [Some("mouth0.png".into()), None, Some("mouth2.png".into())],
            transform: Transform { x: 180.0, y: 20.0, scale: 0.8, opacity: 1.0 },
            visible: true,
        });
        let dir2 = d.path().to_path_buf();
        let portraits = prepare_portraits(&p, d.path(), Path::new("ffmpeg"), d.path(), &|key| {
            crate::waveform::peaks(&dir2.join(format!("{key}.wav")), crate::lipsync::PEAKS_PER_SEC).ok()
        })
        .unwrap();
        assert_eq!(portraits.len(), 1);
        let list = std::fs::read_to_string(&portraits[0].concat).unwrap();
        assert!(list.starts_with("ffconcat version 1.0"));
        assert!(list.lines().filter(|l| l.starts_with("duration")).count() > 3, "{list}");

        // 動画素材（音声付き）と字幕アニメーション
        let st = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=660:d=3"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest"])
            .arg(d.path().join("clip.mp4"))
            .status()
            .unwrap();
        assert!(st.success());
        p.clips.push(Clip {
            id: "v1".into(),
            track_id: "t_media".into(),
            start: 60,
            duration: 60,
            body: ClipBody::Media(MediaClip {
                src: "clip.mp4".into(),
                media_kind: MediaKind::Video,
                has_audio: true,
                in_point: 15,
                volume: 0.8,
                transform: Transform { x: -150.0, y: -80.0, ..Default::default() },
            }),
        });
        p.characters[0].subtitle.animation = SubtitleAnimation::Pop;
        p.characters[1].subtitle.animation = SubtitleAnimation::Typewriter;

        let ass = d.path().join("s.ass");
        std::fs::write(&ass, crate::subtitle::build_ass(&p)).unwrap();
        let out = d.path().join("out.mp4");
        let opt = ExportOptions::new("ffmpeg", &out, d.path());
        let dir = d.path().to_path_buf();
        let args = build_args(&p, &move |id| Some(dir.join(format!("{id}.wav"))), &portraits, Some(&ass), &opt).unwrap();
        let mut last = 0.0;
        run(&args, Path::new("ffmpeg"), p.video.frames_to_secs(p.duration()), &mut |x| last = x).unwrap();
        assert_eq!(last, 1.0);
        let probe = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "default=nw=1"])
            .arg(&out)
            .output()
            .unwrap();
        let s = String::from_utf8_lossy(&probe.stdout);
        assert!(s.contains("codec_type=video") && s.contains("codec_type=audio"), "{s}");
        let dur: f64 = s.lines().find_map(|l| l.strip_prefix("duration=")).unwrap().parse().unwrap();
        assert!((dur - 9.0).abs() < 0.1, "duration={dur}");
    }
}
