import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@astryxdesign/core/theme';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import ja from '@astryxdesign/core/locales/ja-JP.generated.js';
import {voxcutTheme} from './themes/voxcut/voxcut';
import {ToastViewport} from '@astryxdesign/core/Toast';
import {App} from './App';

// mode を指定しないと OS のライト/ダークに従う
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InternationalizationProvider locale="ja-JP" messages={{'ja-JP': ja}}>
      <Theme theme={voxcutTheme}>
        {/* 通知は右上に（下のセリフ入力欄と「追加」ボタンを隠さないように） */}
        <ToastViewport position="topEnd" inset={{top: 52}} maxVisible={3}>
          <App />
        </ToastViewport>
      </Theme>
    </InternationalizationProvider>
  </StrictMode>,
);
