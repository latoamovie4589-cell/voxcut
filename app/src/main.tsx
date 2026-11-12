import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@astryxdesign/core/theme';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import ja from '@astryxdesign/core/locales/ja-JP.generated.js';
import {voxcutTheme} from './themes/voxcut/voxcut';
import {App} from './App';

// mode を指定しないと OS のライト/ダークに従う
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InternationalizationProvider locale="ja-JP" messages={{'ja-JP': ja}}>
      <Theme theme={voxcutTheme}>
        <App />
      </Theme>
    </InternationalizationProvider>
  </StrictMode>,
);
