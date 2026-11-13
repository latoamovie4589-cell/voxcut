// VoxCut のテーマ。Astryx の neutral を土台に、Apple HIG の値へ寄せる。
// Liquid Glass（半透明・ぼかし）は使わない：面はすべて不透明。
// ビルド：npm run theme:build（CSS にして読み込むので、実行時の style 注入がない）

import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral';

// HIG §4：Web ではフォントを配布せずシステムフォントスタックを使う。Windows では Yu Gothic UI / Segoe UI になる
const SYSTEM_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Hiragino Sans", "Yu Gothic UI", "Segoe UI", system-ui, sans-serif';

export const voxcutTheme = defineTheme({
  name: 'voxcut',
  extends: neutralTheme,
  // HIG §5：アクセントは1色（systemBlue のライト／ダーク）
  color: {accent: ['#007AFF', '#0A84FF']},
  typography: {
    // デスクトップアプリなので macOS の本文 13pt を基準にする
    // 本文 14px・補助テキスト 12px 以上（13/1.2 だと補助が 11px を切るため）
    scale: {base: 14, ratio: 1.15},
    body: {family: '-apple-system', fallbacks: SYSTEM_STACK},
    heading: {family: '-apple-system', fallbacks: SYSTEM_STACK},
    code: {family: 'ui-monospace', fallbacks: '"SF Mono", Menlo, Consolas, monospace'},
  },
  // 角の丸みは控えめに（編集ソフトとして詰めて並べるので、丸めすぎると押せる範囲と表示の幅が減る）
  // inner 3 / ボタン・入力 6 / カード・メニュー 9px
  radius: {base: 3, multiplier: 1},
  // HIG §7：応答 0.3〜0.5 秒、控えめ
  motion: {fast: 150, medium: 320, ratio: 0.75},
  tokens: {
    // HIG のセマンティックカラー（[ライト, ダーク]）
    '--color-background-body': ['#F2F2F7', '#000000'], // systemGroupedBackground
    '--color-background-surface': ['#FFFFFF', '#1C1C1E'], // secondarySystemGroupedBackground
    '--color-background-card': ['#FFFFFF', '#2C2C2E'],
    '--color-background-muted': ['#F2F2F7', '#2C2C2E'],
    '--color-border': ['rgba(60,60,67,0.29)', 'rgba(84,84,88,0.60)'], // separator
    // 補助テキスト：HIG の secondaryLabel（60% 透過）は白地で約 3.5:1 なので、4.5:1 を超える濃さにする
    '--color-text-secondary': ['#5B5B63', '#AEAEB2'],
    '--color-error': ['#FF3B30', '#FF453A'],
    '--color-success': ['#34C759', '#30D158'],
    '--color-warning': ['#FF9500', '#FF9F0A'],
  },
  components: {},
});
