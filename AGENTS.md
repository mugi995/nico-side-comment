# AGENTS.md
project概要とあなた(AI)の挙動に関する指示

## directory
- "./PROJECT_PLAN.md": Project概要
- "./KNOWLEDGE.md": 知見メモ

## Project Context
- 動画サイトのフルスクリーンでコメント欄をサイドバー表示する機能を追加する拡張機能


## Plan mode
- web検索による情報収集を前提としたplanningをすること
    - web fecthやscrapling mcpなどを利用(利用しているかはユーザーから確認可能)
    - 自身の内部情報からは判断しないこと 

- 多角的な視点・手段を持って考察と計画をすること
- ファクトチェックを十全に行うこと
- 安易に結論を出さないこと
- 自分が出したあらゆる判断に批判的になること
- Tool Useを効率的に利用すること
- 検索にて得た情報はmarkdownファイルに記録し、知見として残すこと

## Build mode
- 明確にCodingを指示されていない場合、コード変更をしないこと
- ユーザーの承認を挟まないCodingをしないこと
- Plan modeでの決定に沿うこと
- コードはgithubに上げること
- ブランチしてPRを投げる運用をすること
- PR前にテストをすること

