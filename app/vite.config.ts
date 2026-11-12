import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// Tauri から使う前提の設定（ポート固定、画面クリアしない）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {port: 5173, strictPort: true},
  build: {
    // WebView2（Chromium）と WKWebView の現行版が対象
    target: ['chrome120', 'safari17'],
    cssMinify: true,
    // ローカルのディスクから読むので、ネットワーク配信ほどサイズは効かない（gzip 約 310KB）
    chunkSizeWarningLimit: 1200,
  },
});
