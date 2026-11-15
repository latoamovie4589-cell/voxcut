// VoxCut のテーマ。Astryx の neutral を土台に、面の色をすみれ色寄りのインク色にする（文字の大きさ・動きは Apple HIG に寄せる）。
// Liquid Glass（半透明・ぼかし）は使わない：面はすべて不透明。
// ビルド：npm run theme:build（CSS にして読み込むので、実行時の style 注入がない）

import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral';

// HIG §4：Web ではフォントを配布せずシステムフォントスタックを使う。Windows では Yu Gothic UI / Segoe UI になる
const SYSTEM_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Hiragino Sans", "Yu Gothic UI", "Segoe UI", system-ui, sans-serif';

export const voxcutTheme = defineTheme({
  name: 'voxcut',
  extends: neutralTheme,
  // アクセントは 1 色。VoxCut の色として、声・音を思わせるすみれ色（ライト／ダーク）。
  // キャラクターの色（青・橙・緑…）や、エラーの赤・警告の黄と見分けやすい
  color: {accent: ['#6E56CF', '#7A5FEA']}, // ダークでも塗りの濃い紫に白い文字（主ボタンが沈まないように）
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
    // 面の色は、ただの灰色ではなくアクセントのすみれ色をわずかに含んだ「インク色」（[ライト, ダーク]）。
    // body は机（パネルの間に見える地）、surface はその上に載るパネル、card / muted は一段明るい面
    '--color-background-body': ['#ECEAF3', '#0F0E14'],
    '--color-background-surface': ['#FFFFFF', '#1A1921'],
    '--color-background-card': ['#FFFFFF', '#26242F'],
    '--color-background-muted': ['#F1EFF7', '#26242F'],
    '--color-background-popover': ['#FDFCFF', '#2B2935'],
    '--color-border': ['rgba(52,46,84,0.2)', 'rgba(150,142,190,0.24)'],
    '--color-text-primary': ['#1B1A22', '#E8E6F0'],
    // 補助テキスト：白地・暗い地のどちらでも 4.5:1 を超える濃さ
    '--color-text-secondary': ['#5A5866', '#ABA8BA'],
    '--color-icon-primary': ['#1B1A22', '#E8E6F0'],
    '--color-error': ['#FF3B30', '#FF453A'],
    '--color-success': ['#34C759', '#30D158'],
    '--color-warning': ['#FF9500', '#FF9F0A'],
  },
  components: {},
});
