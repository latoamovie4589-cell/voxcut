import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@astryxdesign/core/theme';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import ja from '@astryxdesign/core/locales/ja-JP.generated.js';
import {voxcutTheme} from './themes/voxcut/voxcut';
import {ToastViewport} from '@astryxdesign/core/Toast';
import {App} from './App';
import {FloatApp} from './FloatApp';
import {floatingPanelOfThisWindow, startGuest} from './sync';
import {startHints} from './hints';
startHints();

// 別ウィンドウに切り離したパネルなら、そのパネルだけを出す（状態はメインウィンドウと共有）
const floatPanel = floatingPanelOfThisWindow();
const guest = floatPanel ? startGuest(floatPanel) : null;

// mode を指定しないと OS のライト/ダークに従う
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InternationalizationProvider locale="ja-JP" messages={{'ja-JP': ja}}>
      <Theme theme={voxcutTheme}>
        {/* 通知は右下。セリフ入力欄（下から 50px ほど）の上に出し、タブ・レイヤーの見出し・「追加」ボタンを隠さないように */}
        <ToastViewport position="bottomEnd" inset={{bottom: 64, end: 16}} maxVisible={3} isTopLayer={false}>
          {floatPanel && guest ? <FloatApp panel={floatPanel} onDock={guest.dock} /> : <App />}
        </ToastViewport>
      </Theme>
    </InternationalizationProvider>
  </StrictMode>,
);
