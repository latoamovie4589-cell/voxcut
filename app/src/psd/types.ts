// PSD 立ち絵の共通の型と関数の入り口。
// - compose.ts：PSD を読み、指定した表示状態で 1 枚に合成する（描画モード・クリッピング・マスク・グループ・不透明度）
// - effects.ts：レイヤー効果（境界線・ドロップシャドウ・光彩・オーバーレイなど）付きでレイヤーを描く
// - それ以外（立ち絵の設定画面・焼き込み・書き出し）は portrait.ts と UI が使う
// ここにある型と関数の形は、3 つのファイルの約束なので、変えるときは全部をそろえる。

import type {Layer, Psd} from 'ag-psd';

/** レイヤー（またはグループ）1 つ。id は上からの位置をつないだもの（例 "2/0/5"）で、同じ PSD なら毎回同じになる */
export interface PsdNode {
  id: string;
  name: string;
  kind: 'layer' | 'group';
  /** PSD に保存されていた表示・非表示 */
  visible: boolean;
  /** 名前の先頭が「*」：同じグループの中で 1 つだけ表示する（PSDToolKit・YMM4 と同じ決まり） */
  radio: boolean;
  /** 名前の先頭が「!」：いつも表示する */
  forced: boolean;
  /** 子（グループのとき）。画面で上に描かれるものが先 */
  children: PsdNode[];
  /** 親の id（いちばん上なら null） */
  parent: string | null;
  /** ag-psd のレイヤーそのもの（合成に使う） */
  layer: Layer;
}

export interface PsdDoc {
  width: number;
  height: number;
  /** いちばん上の階層。画面で上に描かれるものが先 */
  nodes: PsdNode[];
  /** id → ノード */
  byId: Map<string, PsdNode>;
  /** PSD に保存されていた合成済みの画像（無い PSD もある）。再現の確かめに使う */
  composite: HTMLCanvasElement | null;
  psd: Psd;
}

/** 表示状態：id → 表示するか。書いていないノードは PSD に保存されていたとおり */
export type Visibility = Record<string, boolean>;
