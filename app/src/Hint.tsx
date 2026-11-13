// 慣れた人には要らない説明文。「表示 → 項目の説明を表示」がオフのときは隠す（hints.ts・app.css の .vx-hint）
import {Text} from '@astryxdesign/core/Text';

export function Hint({children}: {children: React.ReactNode}) {
  return (
    <div className="vx-hint">
      <Text type="supporting">{children}</Text>
    </div>
  );
}
