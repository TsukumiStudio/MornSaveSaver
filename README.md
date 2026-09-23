# MornSaveSaver

稼働先: https://morn-save-saver.pikapikan0526.workers.dev （管理画面は `/admin/`）。ゲームからの利用例は [GMornSaveSaver](https://github.com/TsukumiStudio/GMornSaveSaver) を参照。

Cloudflare Workers + D1 の小さなJSONセーブ保管APIと管理ページです。セーブはユーザーごとに1件だけ保持し、revisionが大きい書き込みだけを保存します。

管理画面では各セーブ行を折りたたみ表示し、展開すると直下にインデント付きの項目を表示します。辞書・配列も個別に展開でき、右端の「JSONで保存」は展開状態を変えずにJSONをダウンロードします。

## セットアップ

1. `npm ci`
2. CloudflareでD1データベースを作り、`wrangler.jsonc` の `database_id` を置き換える。
3. `npx wrangler d1 migrations apply morn-save-saver --remote`
4. 十分にランダムな値を使って `npx wrangler secret put REGISTRATION_SECRET` を実行する。秘密値をソースやコマンド引数に書かない。`REGISTRATION_SECRET` は再登録時のwrite_token再現に使うため、既存利用者がいる間は変更しない。
5. Zero Trust > Access controls > Applications でSelf-hosted applicationを作り、Workerのホスト名の `/admin` と `/v1/admin` を保護する。発行されたApplication Audience (AUD) TagをWorkerの環境変数 `ACCESS_AUD` に設定する（このアプリの値は `wrangler.jsonc` に設定済み）。Workerは `https://tsukumistudio.cloudflareaccess.com` 発行の署名、issuer、audience、有効期限を検査するため、AUDが未設定なら管理機能を閉じる。このWorkerのAccess application IDは `3de6f538-ea0b-4749-bcf4-328599b2d676`、本人に限定する既存ポリシーIDは `2141c159-ae8c-47d8-9b1d-f4b9f15255d8`。
6. `npm run deploy:dry-run` で確認し、必要なタイミングで `npx wrangler deploy`。

ローカルでは `.dev.vars` に `REGISTRATION_SECRET` の開発用値を設定し、`npx wrangler d1 migrations apply morn-save-saver --local` を実行して `npx wrangler dev --local` で起動します。`.dev.vars` はGit管理対象外です。管理画面は `/admin/` です。`/` は `/admin/` に転送します。AccessのJWTが必要なため、有効な署名済みJWTがなければ管理画面/APIには入れません。テストではRSA鍵を生成してローカルJWKS応答を差し替え、本番に認証バイパスは加えず検証します。`/health` は稼働確認用です。

## API

- `POST /v1/users` `{ "project_id": "my-game", "registration_key": "<64 hex chars>" }` → `{ "user_id", "save_id", "write_token" }`。同じプロジェクトと登録キーの再試行は同じIDとtokenを返します。登録キーと書き込みtokenのハッシュ以外は保存しません。
- `PUT /v1/saves/:save_id` `Authorization: Bearer <write_token>` と `{ "data": {}, "revision": 1 }`。新しいrevisionを保存します。同revisionかつ同じJSONは成功し、古いrevisionまたは内容の異なる同revisionは `409` です。
- `GET /v1/admin/saves?project_id=my-game&cursor=<save_id>` と `GET /v1/admin/saves/:save_id` はCloudflare AccessのJWTが必要です。Workerは `Cf-Access-Jwt-Assertion`（または `CF_Authorization` cookie）を検証し、Accessの入口を通らないworkers.dev直アクセスも拒否します。ページあたり最大50件。詳細応答には `data` を含みます。

JSON本文はストリーム読み込みで最大256 KiB、`data` はオブジェクト、revisionは1以上の安全な整数、project IDは英数字・`_`・`-` の1〜64文字です。登録、管理画面、管理APIはIPごとに30回/分、セーブ更新は60回/分のWorkers Rate Limiting bindingで抑制します。Cloudflareのbindingはロケーション単位の緩やかな制限であり、厳密な会計用途ではありません。CORSは登録とセーブ書き込みの公開APIだけに付与し、管理APIには付けません。静的HTMLにも共通セキュリティヘッダーが適用されます。

## テスト

`npm test` はWrangler devとローカルD1に加え、RSA署名したAccess JWTの検証テストを実行します。期限切れ、不正署名、issuer/audience不一致、exp/nbf不正、管理画面/APIの未認証拒否、登録再試行、revision競合、上限、レート制限を確認します。`npm run deploy:dry-run` はデプロイ内容を検査します。
