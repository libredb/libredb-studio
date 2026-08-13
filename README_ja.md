<p align="center">
  <img src="public/logo.svg" width="200" alt="LibreDB Studio Logo" />
</p>

<h1 align="center">LibreDB Studio</h1>

<p align="center">
  <strong>ノートPCではなく、データの隣にデプロイするデータベースエディタ。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README_zh.md">简体中文</a> ·
  <b>日本語</b>
</p>

<p align="center">
  <img src="public/screenshots/hero-demo.gif" alt="LibreDB Studio" width="100%" />
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://sonarcloud.io/project/overview?id=libredb_libredb-studio"><img src="https://sonarcloud.io/api/project_badges/measure?project=libredb_libredb-studio&metric=alert_status" alt="Quality Gate"></a>
  <a href="#テストと品質"><img src="https://img.shields.io/badge/coverage-100%25-brightgreen" alt="Coverage 100%"></a>
  <a href="https://artifacthub.io/packages/helm/libredb-studio/libredb-studio"><img src="https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/libredb-studio" alt="Artifact Hub"></a>
</p>

## クイックスタート

クローンもビルドも不要。1コマンドでフル機能のSQL IDEが立ち上がります。

```bash
# Docker（推奨）
docker run -d -p 3000:3000 ghcr.io/libredb/libredb-studio:latest

# または Node.js 24+ で（Dockerなし）
npx @libredb/studio
```

**http://localhost:3000** を開くだけです。初回起動時に管理者パスワードがログに出力されるので、設定ファイルは要りません。

> localhostでもHTTPSでもない経路（LAN内の `http://192.168.x.x:3000` など）でアクセスする場合は、`AUTH_COOKIE_SECURE=false` を設定してください。設定しないと、ヘルスチェックは正常なのにログインだけが黙って失敗し、ログイン画面に戻され続けます。

Helm、Homebrew、Snap、winget、deb/rpm は[インストール方法](#インストール方法)を参照してください。

## なぜもう一つデータベースツールを作ったのか

マネージドサービスでPostgresを作ると、40秒で使える状態になります。

そこで中身を見ようとすると、ポートをインターネットに開けるか、デスクトップクライアントを入れてSSHトンネルを掘るか、諦めてシェルから叩くことになります。データベースは40秒。そこに窓を1つ開けるのに午後がまるごと消えます。

さらに掛け算になります。アプリはPostgres、ドキュメントはMongo、キャッシュはRedis、イベントはClickHouse。4つのデータベース、4つのクライアント、4組の認証情報。月曜に新しいメンバーが入れば、最初の1行を書く前に、どのデータがどこにあるかを調べ、接続文字列をwikiと3つのDMから探し出し、VPNの権限を待ち、エンジンごとに別々のツールをインストールすることになります。

**データベースは移動しました。** Kubernetesの中へ、マネージドクラウドへ、踏み台越しに辿り着く顧客のVPCへ。**しかし、それを読むツールは移動していません。** 今も重量級のデスクトップアプリで、席数課金で、インストールが前提で、「データベースは1つ、PCは1台、担当者は端末を変えない」という想定の上に立っています。

LibreDB Studioは逆向きです。**データをツールのところへ持ってくるのではなく、ツールがデータのところへ行きます。**

これを真に受けると、好みの問題ではなく仕様になります。

- データも同僚も自分のマシン上にはいないので、エディタはブラウザで動く必要がある。
- クエリが必要になる障害は、あなたがノートPCを開くまで待ってくれないので、スマートフォンにも届く必要がある。
- データベースの隣に置かれるものはすべてそうやって入るので、コンテナ、Helm chart、Operator、ワンクリックテンプレートという形でデプロイされる必要がある。
- エディタが最も役に立つ場所はそのデータベースを作った製品の内側なので、埋め込み可能である必要がある。
- 席数課金で機能に段階のあるツールを、自分が持つすべての環境に置くことはできないので、何も出し惜しみしてはならない。**シングルサインオンが有料になった時点で、そのツールは「デフォルトでデプロイできるもの」ではなくなる。**

> MITは気前の良さではなく、このアーキテクチャの要件です。

## 主な機能

### 10のエンジン、1つのインターフェース

PostgreSQL · MySQL · Oracle · SQL Server · SQLite · MongoDB · Redis · Couchbase · ClickHouse · Apache Druid

スキーマエクスプローラ、ER図、スキーマ差分、モニタリングは全SQLエンジンで共通です。MongoDBとRedisはSQLエンジンではないため、ER図とスキーマ差分はありません。DruidはHTTP SQL APIに貼り付けられるURIがないためhostとportで設定する二重の例外で、生成されるマイグレーションもDDLを出力せず制約を明示します（Couchbaseのスキーマレスなコレクションも同様）。

| データベース | ドライバ | 機能 |
| :--- | :--- | :--- |
| **PostgreSQL** | `pg` | フルSQL IDE、EXPLAIN、トランザクション、クエリキャンセル（`pg_cancel_backend`） |
| **MySQL** | `mysql2` | フルSQL IDE、EXPLAIN、トランザクション、クエリキャンセル（`KILL QUERY`） |
| **Oracle** | `oracledb`（Thinモード） | フルSQL IDE、`FETCH FIRST N ROWS`、`V$`監視ビュー、`ANALYZE TABLE`、`ALTER INDEX REBUILD`、トランザクション |
| **SQL Server** | `mssql` (tedious) | フルSQL IDE、`TOP N` / `OFFSET FETCH`、`sys.dm_*` DMV、`UPDATE STATISTICS`、`DBCC CHECKDB`、トランザクション、Azure SQL自動判別 |
| **SQLite** | `bun:sqlite` / `node:sqlite`（実行時選択） | フルSQL IDE、ファイル型・インメモリ型 |
| **MongoDB** | `mongodb` | JSONクエリエディタ、コレクション操作（find、aggregate、insert、update、delete） |
| **Couchbase** | ドライバなし、HTTPのみ（Query + 管理REST） | フルSQL++ IDE、EXPLAIN、bucket/scope/collectionエクスプローラ、`INFER`によるカラム推論 |
| **ClickHouse** | ドライバなし、HTTPのみ（SQLインターフェース、8123） | フルSQL IDE、JSON EXPLAINツリー、システムテーブルからのスキーマ取得、`OPTIMIZE TABLE` |
| **Apache Druid** | ドライバなし、HTTPのみ（`POST /druid/v2/sql`） | 読み取り専用SQL IDE、ネイティブクエリのEXPLAINツリー、`INFORMATION_SCHEMA`、`sys.*`監視 |
| **Redis** | `ioredis` | コマンドエディタ、キーブラウザ、INFOベースの監視 |

> **トランスポート層のセキュリティはエンジンごとではなく横断的な機能です。** SSHトンネルはproviderが接続する前に張られ、接続先はローカルのエンドポイントに書き換えられます。つまりエンジンに依存せず、hostとportが設定された接続であれば適用されます。接続文字列で入力した接続（MongoDB、Couchbase、ClickHouseで選択できます）はhostもportも持たないためトンネルされません。SQLiteも同様です。SSL/TLSパネルが実際に効くのはPostgreSQL、MySQL、SQL Server、Couchbase、ClickHouse、Druidです。Oracle、MongoDB、Redisはこの設定を無視するため、この3つで暗号化されるかどうかはダイアログの選択ではなく接続文字列の内容次第になります。

> RedisがこのSQL指向のインターフェースに乗るのは規約によるものです。`getSchema()` はブロッキングしない `SCAN`（**`KEYS *` は使いません**）でキーのプレフィックスを「テーブル」としてまとめ、ヘルスとメトリクスは `INFO`、スロークエリとセッションは `SLOWLOG GET` / `CLIENT LIST` から取得します。

### プロ仕様のSQLエディタ

- **Monacoエンジン**：VS Codeと同じコア。
- **スキーマを理解する補完**：テーブル名、カラム名、SQLキーワード。
- **マルチタブ**：タブごとに独立した実行状態。
- **ビジュアルEXPLAIN**：実行計画をグラフで表示し、ボトルネックを特定。
- **インタラクティブER図**：実際の外部キーをエッジとして描画、カーディナリティ表示、MiniMap、テーブル検索、PNG/SVGエクスポート。ELK.jsによる自動階層レイアウト。
- **スキーマ差分とマイグレーション**：接続間・スナップショット間の比較を色分け表示し、マイグレーションSQLを自動生成（PostgreSQL、MySQL、SQLite、Oracle、SQL Server、およびClickHouseのカラム変更）。
- **スナップショットタイムライン**：任意の2点をクリックしてスキーマの変遷を比較。

<p align="center">
  <img src="public/screenshots/erd-diagram.png" alt="ER図" width="100%" />
</p>

### AI機能（任意・自分のモデルで）

- **ベンダー非依存**：既定はGemini 2.5 Flash。OpenAI、Claude、**ローカルLLM**（Ollama / LM Studio）にも対応。
- **クエリ安全性分析**：DELETE、DROP、TRUNCATEなど破壊的な操作を実行前に評価。
- **実行計画の解説**：EXPLAINを平易な言葉に翻訳し、改善案を提示。

**キーを設定しなければ、AIは一切呼び出されません。** 既定では何もネットワークの外に出ません。

### データ操作

- **仮想化グリッド**（TanStack）：100万行規模でも滑らかに描画。
- **インライン編集**：ダブルクリックで値を直接更新（単一テーブルの行更新をSQLが持つエンジンでのみ表示）。
- **ピボットテーブル**：クライアントサイドで集計関数5種、対応するSQLも生成。
- **8種類のチャート**：棒、折れ線、円、エリア、散布、ヒストグラム、積み上げ棒、積み上げエリア（Recharts）。設定は保存して再利用可能。
- **エクスポート**：CSV、JSON。

### 分析・開発ツール

- **AIデータプロファイラ**：カラム統計（NULL率、カーディナリティ、最小最大、サンプル値）とAIによる要約をワンクリックで生成。
- **ORMコード生成**：ライブスキーマからTypeScript interface、Zod schema、Prisma model、Go struct、Python dataclass、Java POJOを生成。
- **テストデータ生成**：30種類以上のセマンティック推論（メール、電話番号、氏名、住所など）でINSERT文またはMongoDBのinsertMany JSONを出力。
- **データベースドキュメント**：ライブスキーマから検索可能なデータディクショナリを自動生成、Markdownエクスポート対応。

### 認証とSSO：すべてMITビルドに含まれます

- **2つのモード**：ローカルのメール／パスワード、またはOIDCシングルサインオン。環境変数で切り替え。
- **プロバイダを選ばない**：Auth0、Keycloak、Okta、Azure AD、Zitadel、Googleなど、OIDC準拠であれば何でも。
- **PKCE**：Authorization Code Flow + S256。
- **ロールマッピング**：claimベースで設定可能。`realm_access.roles` のようなネストしたパスにも対応。

### DBA運用ツール（管理者のみ）

7タブのモニタリング（概要、パフォーマンス、クエリ、セッション、テーブル、ストレージ、コネクションプール）、時系列トレンドグラフ、5〜60秒で調整可能な自動更新、しきい値による色分けアラート、そしてワンクリックの `VACUUM` / `ANALYZE` / `REINDEX` / `UPDATE STATISTICS` / `DBCC CHECKDB` / `ALTER INDEX REBUILD`。組織全体のクエリ監査ログも含みます。

## インストール方法

| 方法 | コマンド |
| :--- | :--- |
| **Docker** | `docker run -d -p 3000:3000 ghcr.io/libredb/libredb-studio:latest` |
| **npx** | `npx @libredb/studio` |
| **Helm** | `helm install libredb oci://ghcr.io/libredb/charts/libredb-studio` |
| **Homebrew** | `brew trust libredb/tap && brew install libredb/tap/libredb-studio` |
| **Snap** | `sudo snap install libredb-studio` |
| **winget** | `winget install LibreDB.Studio` |
| **deb / rpm**（サーバ版、systemdユニット同梱） | [リリースページ](https://github.com/libredb/libredb-studio/releases/latest) |
| **デスクトップアプリ**（AppImage / deb） | [リリースページ](https://github.com/libredb/libredb-studio/releases/latest)。ネイティブウィンドウで、サーバはローカルのサイドカーとして動作し、ログイン画面はありません。**上のサーバ版とは別物です。** |
| **デスクトップアプリ**（Flatpak、サンドボックス） | `flatpak --user remote-add --if-not-exists flatpark https://dl.flatpark.org/flatpark.flatpakrepo`<br>`flatpak --user install flatpark org.libredb.Studio` |

`brew trust` は最初の一度だけ必要です（Homebrew 6+。「unknown command」と出る場合は先に `brew update`）。Docker、Helm、Snapはゼロコンフィグで、初回起動時に生成される管理者パスワードはそれぞれコンテナログ、Podログ、`sudo snap logs libredb-studio` に出力されます。チャネルごとの詳細（コマンド、設定、systemdの使い方、Dockerイメージのタグ体系）は [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) にあります。

ワンクリックテンプレート：Railway、Dokploy、CapRover、Sealos、Kubero、Cosmos、DigitalOcean Marketplace、Unraid Community Apps、Render Blueprint、Fly.io、Koyeb。一覧は [`docs/CHANNELS.md`](docs/CHANNELS.md) にあります。

Kubernetes向けにはOpenShift / OLM Operator bundleも用意しています。

### 自分のプロダクトに埋め込む

```bash
npm i @libredb/studio
```

Studioはnpmパッケージとしても配布されているので、自分のアプリケーションの中に直接埋め込めます。ユーザーのためにデータベースを作る製品なら、エディタが最も役に立つのはその内側です。

## 有料との線引きについて

StudioがMITなのは、あらゆる場所に置ける必要があるからです。有料なのはlibredb-platformで、そこで売っているのは「運用の代行」、つまりホスティング、テナント管理、課金、サポートであって、有料の壁の向こうに移された機能ではありません。

**アップグレードの理由を作るために線の向こう側へ移された機能は、1つもありません。** SSO、RBAC、クエリ監査ログ、ER図、AI機能、NoSQLエンジン群、すべてMITビルドに入っています。

## テストと品質

- ユニット、API、統合、hooks、コンポーネント、E2Eの6層
- **行カバレッジ100%**、しかもCIの必須ゲート。下がればマージできません
- SonarCloud品質ゲート
- リリースごとにNode 24 / 26でスモークテスト

```bash
bun run test           # 全テスト
bun run test:e2e       # Playwright（ビルドが必要）
bun run test:coverage  # カバレッジレポート
```

## ドキュメント

詳細ドキュメントは現在のところ英語のみです。

- [アーキテクチャ](docs/ARCHITECTURE.md) · [データベースプロバイダ](docs/DATABASE_PROVIDERS.md) · [エンジン別リファレンス](docs/providers/README.md)
- [APIドキュメント](docs/API_DOCS.md) · [OIDC設定](docs/OIDC.md) · [ストレージ](docs/STORAGE.md)
- [Helm Chart](docs/HELM_CHART.md) · [配布チャネル](docs/CHANNELS.md) · [データベースの追加](docs/ADDING_A_PROVIDER.md)

## コントリビューション

IssueもPRも歓迎です。日本語でも構いません。まず [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

データベースエンジンを追加する場合は [`docs/ADDING_A_PROVIDER.md`](docs/ADDING_A_PROVIDER.md) を参照してください。コード・ドキュメント・テストは同じPRの中で揃っている必要があります。

## ライセンス

[MIT](LICENSE)。CLAなし、エンタープライズ版なし、出し惜しみなし。
