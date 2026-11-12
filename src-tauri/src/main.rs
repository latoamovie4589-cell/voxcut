// リリースビルドではコンソール窓を出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::AppState;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = AppState::load(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::new_project,
            commands::open_project,
            commands::save_project,
            commands::get_config,
            commands::set_config,
            commands::engine_status,
            commands::list_voices,
            commands::synthesize,
            commands::waveform,
            commands::audio_path,
            commands::export_video,
            commands::probe_media,
            commands::allow_paths,
            commands::make_proxy,
            commands::cancel_export,
        ])
        .run(tauri::generate_context!())
        .expect("VoxCut を起動できませんでした");
}
