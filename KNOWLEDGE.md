# ニコニコ動画 視聴ページ DOM解析・API 知見

## 取得日
- 初期DOM解析: 2026-08-09
- 拡張機能実装完了: 2026-08-09

## ページ情報
- URL: `https://www.nicovideo.jp/watch/sm46617115`（解析用）
- 技術スタック: React 18 (Remix SSR) + Panda CSS (atomic CSS) + @ark-ui/react
- プレイヤー: nvpc_next（React Router manifestベースの遅延ロード構成）

## 重要セレクタ一覧

| 対象 | セレクタ |
|------|----------|
| フルスクリーン対象要素 | `[data-styling-name="fullscreen-target"]` |
| フルスクリーンボタン | `button[aria-label="全画面表示する"]` |
| コメントリストトグル | `[aria-label*="コメントリスト"]` |
| コメント入力 | `textarea[placeholder="コメントを入力"]` |
| 動画タイトル | `main h1.fs_xl.fw_bold` |
| サイドバー領域 | `[class*="grid-area_[sidebar]"]` |
| プレイヤーコントローラー | `[data-styling-area="floating"]` |
| Canvasコメント | `[data-name="comment"] canvas` |
| 動画要素 | `video[data-name="video-content"]` |

※ `div[data-decoration-video-id]` は**コメントリストではなく**動画詳細情報パネル等に使われる。コメントリストは仮想スクローラー構造。

## レイアウト構造
- CSS Grid: `grid-template-areas: [player sidebar] [bottom sidebar]`
- フルスクリーン時、サイドバー（grid-area_[sidebar]）は非表示

## フルスクリーンの実態（重要）
- ニコニコは `document.body.requestFullscreen()` を使用し、**CSSで疑似フルスクリーン**を実現
- `document.fullscreenElement` は `<body>` になるため、フルスクリーンtargetとの**参照比較は不可**
- 検知は「`fullscreenElement` が非null かつ `[data-styling-name="fullscreen-target"]` が存在」で判定
- フルスクリーン時、ニコニコが動的CSSを注入:
  ```css
  :not(:has([data-styling-name="fullscreen-target"]),
       [data-styling-name="fullscreen-target"],
       [data-styling-name="fullscreen-target"] *,
       :has([data-nvpc-scope="watch-floating-panel"]),
       [data-nvpc-scope="watch-floating-panel"],
       [data-nvpc-scope="watch-floating-panel"] *,
       ... body) { display: none; }
  ```
- **フルスクリーンCSS免除トリック**: 自前要素に `data-nvpc-scope="watch-floating-panel"` 属性を付与すると例外リストに一致し、`display:none` を回避できる（overlay表示に使用）

## コメントAPI仕様（最重要・2026年現在）

### エンドポイント
```
POST https://public.nvcomment.nicovideo.jp/v1/threads?_frontendId=6
Headers: X-Frontend-Id: 6, X-Frontend-Version: 0
```
- `nvcomment.nicovideo.jp` は**廃止済み**（DNS解決不可）。`public.` プレフィックスが現行
- `credentials` を付けると CORS エラー（サーバーが `Access-Control-Allow-Origin: *` を返すため）。**付けないこと**（プレイヤーも `credentials: omit`）

### リクエストボディ（プレイヤーと同一形式）
```json
{
  "params": {
    "targets": [
      { "id": "1545978061", "fork": "owner" },
      { "id": "1545978061", "fork": "main" },
      { "id": "1545978061", "fork": "easy" }
    ],
    "language": "ja-jp"
  },
  "threadKey": "JWT...",
  "additionals": {}
}
```
- `targets`/`language` は `params` フィールド内にネスト必須（フラットにすると `INVALID_PARAMETER`）
- fork: `owner` / `main` / `easy` の3種

### threadKey取得
```
GET https://nvapi.nicovideo.jp/v1/comment/keys/thread?videoId=smXXXX
Headers: X-Frontend-Id: 6, X-Frontend-Version: 0
→ {"meta":{"status":200},"data":{"threadKey":"JWT..."}}
```
- レスポンスはJSONラッパー。`keyResp.json().data.threadKey` で抽出（`text()` はNG）
- **有効期限が約3分**と非常に短い。取得直後に使用すること
- JWTペイロードに `tids`（スレッドID配列）と `d`（動画長）が含まれる

### レスポンス
```json
{
  "meta": {"status": 200},
  "data": {
    "threads": [
      { "fork": "main", "comments": [
        { "id": "...", "no": 4118020, "vposMs": 361140, "body": "...",
          "commands": ["184"], "userId": "...", "isPremium": true,
          "postedAt": "...", "nicoruCount": 20, "source": "trunk" }
      ]}
    ]
  }
}
```
- `vposMs`: 動画内位置（ミリ秒）。タイムコード同期はこれを使用
- 投稿者コメントは `$fork === "owner"` 相当（fork:"owner"）で識別

## React fiber からのデータ抽出

`findNvComment()` で `response.comment.nvComment`（`server`/`threadKey`/`params`）を取得可能:
```javascript
const root = document.getElementById("root");
const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
while (el = walker.nextNode()) {
  for (const key of Object.keys(el)) {
    if (key.startsWith("__reactFiber$")) {
      let fiber = el[key];
      while (fiber) {
        if (fiber.memoizedProps?.response?.comment?.nvComment?.threadKey) {
          return fiber.memoizedProps.response.comment.nvComment;
        }
        fiber = fiber.return;
      }
    }
  }
}
```
- プレイヤーが使う最新の有効なthreadKeyをそのまま利用できる（keys/thread API呼び出し不要）
- 最善の実装: React探索を主、keys/thread APIをフォールバックに

## 仮想スクローラー（DOMクローン方式の課題）
- サイドバーコメントは仮想スクローラー: コンテナ `div.pos_relative[style*="height"]` 内に `[data-index]` 付きアイテムを `position:absolute; transform:translateY(...)` で配置
- **フルスクリーン中は `display:none` によりDOM生成が停止** → DOMクローン方式では全件取得が遅く・不完全
- クローン時は `position/transform` を除去して自然表示が必要
- → **API方式（nvcomment）が正解**。全件1秒以内・vposMsソート可能

## 拡張機能実装上の注意点
- コメントリストパネルはデフォルトで閉じている可能性あり（要toggleクリック）
- Reactによる再レンダーで注入DOMが削除される可能性あり（RAFでの生存監視で対策）
- SPA遷移時に `data-decoration-video-id` の値が変化（動画IDに依存）
- プレイヤーのJSバンドル解析が仕様特定に有効:
  - `enum-Gzjippc4.js`: 全API定義（`/v1/comment/keys/*` 等）
  - `PlayerSeekBar-Gcj4xJ-p.js`: コメント取得実装（`POST /v1/threads` のリクエスト形式が判明）
  - `WatchLayoutLazySidebar-CyNxdXY5.js`: コメントリストUI

## 開発履歴の教訓
1. **DOMクローン方式**（最初）: フルスクリーン中の仮想スクローラー停止により不完全 → API方式へ転換
2. **`nvcomment.nicovideo.jp` がDNS解決不可**: ページHTMLの `preconnect` から `public.nvcomment.nicovideo.jp` を発見
3. **CORS**: `credentials: include` がサーバーの `ACAO: *` と衝突 → 削除で解決
4. **threadKey抽出**: `keyResp.text()` ではJSONラッパーごと入る → `.json().data.threadKey` が正解
5. **ボディ構造**: `targets` をフラットに送ると空/400 → `params` ネストが正解
6. **フルスクリーン検知**: `fullscreenElement === target` の厳密比較は不可（bodyが対象）
7. **overlay非表示問題**: `data-nvpc-scope="watch-floating-panel"` 付与で解決
