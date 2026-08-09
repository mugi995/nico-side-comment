# Nico Side Comment

ニコニコ動画のフルスクリーン表示中に、コメントリストをサイドバー表示する Chrome 拡張機能。

## 機能

- フルスクリーン時に動画右側へコメントサイドバーを表示
- ニコニコの公式コメント API（nvcomment）から全コメントを一括取得
- タイムコード（vposMs）順にソート表示
- 動画再生位置に合わせて自動スクロール + 現在位置のコメントをハイライト
- ツールバーアイコンクリックで ON/OFF 切り替え

## インストール

1. `chrome://extensions/` を開く
2. デベロッパーモードを有効化
3. 「パッケージ化されていない拡張機能を読み込む」から本ディレクトリを選択
4. ツールバーアイコンをクリックして有効化（緑色 = ON）

## 使い方

1. ニコニコ動画の視聴ページ（`https://www.nicovideo.jp/watch/*`）を開く
2. プレイヤーの全画面ボタンをクリック（F11 ではありません）
3. 動画右側にコメントリストが表示される

## ファイル構成

```
├── manifest.json    # Chrome拡張定義 (Manifest V3)
├── background.js    # Service Worker（ON/OFF切り替え）
├── content.js       # メインロジック（コメント取得・サイドバー表示）
├── sidebar.css      # サイドバーoverlay用スタイル
├── icons/           # ツールバーアイコン
└── KNOWLEDGE.md     # ニコニコAPI・DOM解析の知見メモ
```

## 技術メモ

- コメント取得: `POST https://public.nvcomment.nicovideo.jp/v1/threads`
- threadKey: `nvapi.nicovideo.jp/v1/comment/keys/thread` で取得（有効期限約3分）
- 詳細は `KNOWLEDGE.md` 参照
