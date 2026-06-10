# 開発メモ(にじみ)

このプロジェクトの日常的なコマンドと運用ルールのメモ。

## 環境

- WSL2 (AlmaLinux) + Node.js (nvm管理)
- Vite + React
- GitHub Pages で実機テスト用に公開中: https://fuyunon.github.io/nijimi/

## よく使うコマンド

| やりたいこと | コマンド |
|---|---|
| 開発サーバー起動(保存で即反映) | `npm run dev` |
| 本番ビルド(dist/ に出力するだけ) | `npm run build` |
| ビルド結果をローカルで確認 | `npm run preview` |
| GitHub Pages に公開(実機テスト更新) | `npm run deploy` |

- `npm run dev` … 開発中の確認用。`http://localhost:5173` をWindows側ブラウザで開ける(WSL2は自動転送)。
- `npm run deploy` … 内部で build も走る。iPhoneで実機確認したいときはこれ1つでOK。
  反映に1〜2分。古い表示が出たらSafariを閉じて開き直す(プライベートタブだと確実)。

## ブランチ運用

- `main` … リリース可能な状態(= App Store に出した状態と一致させる)。デフォルトブランチ。
- `develop` … 開発中。普段の作業はこちらで行う。
- `main` への直接 push は ruleset で禁止。必ず PR 経由でマージする。

### 開発のサイクル

```bash
# developで作業
git checkout develop
# (コードを編集)
git add .
git commit -m "変更内容"
git push
```

### PR作成 → マージ

PR作成用URL(base: main ← compare: develop):

```
https://github.com/fuyunon/nijimi/compare/main...develop
```

このURLを開く → Create pull request → Merge pull request → Confirm merge。

### マージ後の後片付け

```bash
git checkout main
git pull              # マージ後のmainを取得
git checkout develop
git merge main        # developをmainに追いつかせて両ブランチを揃える
git push
```

## GitHub Pages デプロイの注意

- `npm run deploy` は「今チェックアウト中のブランチの内容」を公開する(main/developどちらからでも可)。
- 開発中の実機確認は develop から deploy してOK。
- 公開ページを「正式版」として保つなら、main にマージ後 main をチェックアウトしてから deploy する。

## ファイル配置メモ

- アプリ本体: `src/App.jsx`
- アプリアイコン(原本・ファビコン兼用): `public/icons/nijimi-icon-1024.png`
  - App Store 提出時は App Store Connect に直接アップロードする(リポジトリ内のものは保管・ファビコン用)。

## 認証メモ

- push で毎回トークンを聞かれる場合: `git config --global credential.helper store` で一度入力すれば記憶される。
- トークン期限切れ時: `rm ~/.git-credentials` してから新トークンで push し直す。
