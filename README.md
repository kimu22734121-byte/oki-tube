# oki-tube

お気に入りのYouTube動画を、Apple Musicのライブラリのようにプレイリストで管理して連続再生できるWebアプリです。
パソコン・iPhone・Androidのどのブラウザで開いても、Googleログインすれば**同じプレイリスト**がリアルタイムに表示されます。

## 主な機能

- プレイリストの作成・名前変更・削除（一覧はサムネイル付きのタイル表示（リスト表示にも切り替え可能。カバーは動画4本以上なら4分割でランダム表示）。末尾の「＋ 新規作成」からすぐ作れます）
- 動画の追加：アプリ内でYouTube検索（YouTube Data API v3）／YouTubeのURLを貼り付け（複数行OK）／追加先をその場で新規作成も可能
- 動画の並べ替え（ドラッグ）・削除（元に戻す付き）、チャンネル別の一覧・再生
- YouTube公式の埋め込みプレーヤー（IFrame Player API）での連続再生、前へ／次へ、シャッフル、リピート（オフ／全体／1曲）
- 表示モード：**通常** / **視聴**（動画を大きく）/ **BGM**（リスト中心）/ **運転**（大きなボタンだけ）
- Firebase（Firestore）で全端末にリアルタイム同期、オフラインでも表示が壊れません（再接続後に自動同期）
- JSONでのバックアップ書き出し・読み込み

> YouTubeの利用規約に従い、公式の埋め込みプレーヤーのみを使います。動画のダウンロードや、バックグラウンド再生の回避は行いません。
> 運転モードでもプレーヤー（動画）は小さく表示したままです。運転中は安全を最優先にしてください。

## しくみ（ビルド不要）

HTML / CSS / JavaScript だけの静的サイトです。インストールやビルドは要りません。
データは Firebase の Cloud Firestore（無料のSparkプラン）に、`users/{あなたのUID}/playlists/…` として保存されます。

## セットアップ手順（初心者向け）

### 1. Firebaseプロジェクトを作る
1. <https://console.firebase.google.com/> を開き、Googleアカウントでログイン
2. 「プロジェクトを追加」→ 好きな名前（例: `oki-tube`）→ Google アナリティクスは「オフ」でOK → 作成
3. 料金プランは **Spark（無料）** のままでOKです（このアプリは無料枠で十分動きます）

### 2. Cloud Firestore を有効にする
1. 左メニュー「構築」→「**Firestore Database**」→「データベースを作成」
2. ロケーションは `asia-northeast1`（東京）などを選ぶ
3. モードは「**本番環境モード**」を選んで作成（ルールは次の手順で設定します）

### 3. セキュリティルールを設定する（重要）
1. Firestore Database の「**ルール**」タブを開く
2. 中身をすべて消して、このリポジトリの [`firestore.rules`](firestore.rules) の内容を貼り付け、「公開」を押す

これで「ログインした本人が、自分のデータ（`users/自分のUID/`）だけ」読み書きできます。他人のデータや、それ以外の場所は読み書きできません。

### 4. Googleログインを有効にする
1. 左メニュー「構築」→「**Authentication**」→「始める」
2. 「Sign-in method」タブ → 「**Google**」→ 有効にする → サポートメールを選んで保存

### 5. ウェブアプリを登録して設定値を取る
1. プロジェクトの設定（歯車）→「全般」→ 下の「マイアプリ」で `</>`（ウェブ）を選ぶ
2. ニックネームを付けて登録（「Firebase Hosting」のチェックは不要）
3. 表示される `firebaseConfig` の `apiKey` / `authDomain` / `projectId` / `appId` を、[`js/firebase-config.js`](js/firebase-config.js) に書き込む

```js
export default {
  apiKey: "AIza....",
  authDomain: "xxxx.firebaseapp.com",
  projectId: "xxxx",
  appId: "1:123:web:abc"
};
```

> ここの値は**公開しても安全な設定値**です（パスワードではありません）。守っているのは手順3のルールとログインです。
> 公開したくない場合は、このファイルを空のままにして、アプリ起動後の画面に `firebaseConfig` を貼り付ける方法もあります（ただしその端末にだけ保存されるので、端末ごとに入力が必要です）。
> **YouTubeのAPIキーは絶対にこのファイルやリポジトリに書かないでください。**

### 6. アプリを公開する（GitHub Pages）
1. このリポジトリの Settings → **Pages** → Source を「**GitHub Actions**」にする
2. `main` ブランチに変更を push（マージ）すると、自動で公開されます（`.github/workflows/pages.yml`）
3. 公開URL（例: `https://ユーザー名.github.io/oki-tube/`）が決まったら、Firebase の Authentication →「設定」→「**承認済みドメイン**」に `ユーザー名.github.io` を追加（これを忘れるとログインできません）

> 手元で試すだけなら、フォルダで `python3 -m http.server 8000` を実行して <http://localhost:8000> を開けます（`localhost` は最初から承認済みです）。
> Firebase Hosting（Sparkプランで無料）に公開する方法もあります：`firebase deploy`（`firebase.json` を同梱）。

### 7. YouTube APIキーを取る（検索機能に必要）
1. <https://console.cloud.google.com/> で、先ほどのFirebaseと同じプロジェクトを選ぶ
2. 「APIとサービス」→「ライブラリ」→ **YouTube Data API v3** を有効にする
3. 「認証情報」→「認証情報を作成」→「APIキー」
4. 作成したキーの「**アプリケーションの制限**」を「ウェブサイト（HTTPリファラー）」にして、公開URL（例: `https://ユーザー名.github.io/*`、手元用に `http://localhost:8000/*`）を登録。「APIの制限」は YouTube Data API v3 にする（他人に使われにくくなります）
5. アプリの「**設定**」画面にキーを貼り付けて「保存」（「接続テスト」で確認できます）

キーは**その端末のブラウザ（localStorage）にだけ**保存されます。コードにもGitHubにもFirestoreにも送られません。スマホとパソコンそれぞれで一度入力してください。
検索は1回あたりAPIの割当を100消費します（無料枠は1日10,000なので、1日約100回まで）。URLでの追加はほぼ消費しません（キーなしでも使えます）。

## 使い方のヒント

- 右上のボタンで表示モードを切り替え：🖥通常 / 🎬視聴 / 🎧BGM / 🚗運転（`Esc`キーで通常に戻ります）
- プレイリストを開いて「並べ替え・削除」を押すと、左の≡をドラッグして並べ替え、🗑で削除できます
- 「チャンネル」タブで、チャンネルごとに全プレイリストの動画をまとめて再生できます
- 設定 →「書き出す」でバックアップ（JSON）。「読み込む」は新しいプレイリストとして追加されます
- iPhone/Androidでは「ホーム画面に追加」するとアプリのように使えます

## 注意

- 一部の動画は投稿者が埋め込み再生を禁止しているため再生できません（自動で次の曲に進みます）
- 動画の再生はYouTube側の仕様に従います（広告・画面を閉じた時の挙動など）。iPhoneなどでは、画面ロック中の再生はブラウザやYouTubeの仕様に依存します
- 1つのプレイリストに入れられる動画は2000本までです

## ファイル構成

```
index.html            画面の骨組み
css/style.css         デザイン（表示モード含む）
js/main.js            起動・画面遷移・再生ボタン・表示モード
js/views.js           各画面（ライブラリ/プレイリスト/追加/チャンネル/設定）
js/store.js           Firebase（ログイン・Firestore同期・バックアップ）
js/player.js          YouTube IFrame Player API（キュー/シャッフル/リピート）
js/yt.js              YouTube Data API・URL解析
js/firebase-config.js Firebaseの設定値（秘密ではない）
sw.js                 オフライン用キャッシュ
firestore.rules       Firestoreセキュリティルール
```
