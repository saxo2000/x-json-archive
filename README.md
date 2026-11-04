# X JSON Archive（PWA）

▶ https://saxo2000.github.io/x-json-archive/ （GitHub Pages）

X（旧Twitter）の投稿JSONアーカイブを、**端末内だけで**読み込み・検索・表示するビューアです。
サーバーに送信しません。ファイルはブラウザ内（SAFのファイル選択）で処理します。

## 他の端末で使う

`DEPLOY.md` を参照。手っ取り早いのは、
- 同じWi-Fi内：`./start-lan.sh` → 表示された `http://<この端末のIP>:8767/` を開く
- どこからでも：Netlify Drop 等に `index.html`/`app.js`/`sw.js`/`manifest.webmanifest`/`icons` を置く

## 使い方（Android の dsh-go 環境）

1. サーバーを起動（このフォルダで）
   ```
   cd /root/workspace/x-archive
   python3 serve.py 8765
   ```
2. スマホのブラウザで `http://127.0.0.1:8765/` を開く
3. 右上メニューの「オフラインで開けるように保存」→ **ホーム画面に追加**（アプリとして起動）
4. アプリ内の **「JSONを開く」** → SAFのファイル選択で `.json` を選ぶ

> ホーム画面から起動した PWA では、ファイル選択（SAF）が使えます。
> 「どのJSONを使ったか」は端末内に記憶しますが、ブラウザの制約で**自動再読み込みはできません**（毎回選び直し）。

## できること

- 投稿カード表示（@ユーザー名 / 日付 / 本文 / 「投稿を開く」リンク / メディア画像）
- 検索：本文・ユーザー名・日付・ID・URL。**空白区切りでAND**。大小文字・全角半角・ひらがな/カタカナの揺れを吸収
- 並び順：新しい順 / 古い順 / ユーザー名順 / 画像あり先
- ユーザー絞り込み
- 40件ずつ「さらに読み込む」表示（数万件でも軽い）
- 画像はオンライン時のみ読み込み。オフライン時は「タップで開く」プレースホルダ
- 対応形式：配列 `[...]`、`{"tweets":[...]}` などの包み、JSON Lines、末尾が切れたJSON（可能な分だけ救出）

## 書式ヘルプ

キー名が違っても動きます（画面の「書式ヘルプ」に認識結果を表示）。認識する主な別名：

| 用途 | キー |
|---|---|
| id | id, id_str, tweet_id, rest_id |
| username | username, screen_name, user, author, handle |
| date | date, created_at, timestamp, time |
| text | text, full_text, content, body |
| url | url, permalink, link |
| media | media, images, photos, media_urls |
| savedAt | savedAt, saved_at, bookmarkedAt |

## メモ

- 数MB（〜数十万件）なら読み込み時に全文検索インデックスを自動構築します。超大容量時は「全文検索を有効化」ボタンが出ます。
- 画像は `pbs.twimg.com` など外部URLを参照するため、ネット接続が必要です（Xの仕様変更で古い画像が消えている場合あり）。
- `?load=<url>` を付けると同一オリジンのJSONを自動読み込みできます（テスト用）。
- `sample.json` は動作確認用のダミーデータです。
