<p align="center">
  <img src="public/logo.svg" width="200" alt="LibreDB Studio Logo" />
</p>

<h1 align="center">LibreDB Studio</h1>

<p align="center" dir="rtl">
  <strong>ڈیٹا بیس ایڈیٹر جو آپ کے ڈیٹا کے ساتھ deploy ہوتا ہے، آپ کے laptop کے اندر نہیں۔</strong>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README_zh.md">简体中文</a> ·
  <a href="README_ja.md">日本語</a> ·
  <a href="README_es.md">Español</a> ·
  <b>اردو</b>
</p>

<p align="center" dir="rtl">
  PostgreSQL project میں درج شدہ:
  <a href="https://www.postgresql.org/about/news/libredb-studio-an-open-source-self-hosted-sql-ide-for-postgresql-in-the-browser-3368/">News</a>
  ·
  <a href="https://www.postgresql.org/download/products/1/">Software Catalogue</a>
  ·
  <a href="https://wiki.postgresql.org/wiki/Community_Guide_to_PostgreSQL_GUI_Tools#LibreDB_Studio">Community Guide to GUI Tools</a>
</p>
<p align="center" dir="rtl">
  اس کے علاوہ
  <a href="https://redis.io/docs/latest/develop/tools/#libredb-studio">Redis</a>،
  <a href="https://clickhouse.com/docs/integrations/connectors/tools/gui#libredb-studio">ClickHouse</a>
  اور
  <a href="https://druid.apache.org/libraries">Apache Druid</a>
  کی سرکاری دستاویزات میں بھی درج ہے
</p>

<p align="center">
  <img src="public/screenshots/hero-demo.gif" alt="LibreDB Studio" width="100%" />
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://sonarcloud.io/project/overview?id=libredb_libredb-studio"><img src="https://sonarcloud.io/api/project_badges/measure?project=libredb_libredb-studio&metric=alert_status" alt="Quality Gate"></a>
  <a href="https://codecov.io/github/libredb/libredb-studio"><img src="https://codecov.io/github/libredb/libredb-studio/graph/badge.svg?token=VA6CO9R7IH" alt="Coverage"></a>
  <a href="https://artifacthub.io/packages/helm/libredb-studio/libredb-studio"><img src="https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/libredb-studio" alt="Artifact Hub"></a>
</p>

<div dir="rtl" align="right">

## <span dir="rtl">فوری آغاز</span>

<span dir="rtl">صرف ایک کمانڈ سے مکمل SQL IDE: نہ clone کرنے کی ضرورت، نہ build کرنے کی۔</span>

</div>

```bash
# Docker (recommended)
docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest

# or with Node.js 24+ (without Docker)
npx @libredb/studio
```

<div dir="rtl" align="right">

<span dir="rtl">پھر **<span dir="ltr">http://localhost:3000</span>** کھولیں۔ پہلی بار چلنے پر administrator کا password کسی configuration file کے بغیر log میں پرنٹ ہو جاتا ہے۔</span>

> <span dir="rtl">اگر browser localhost یا HTTPS سے نہیں کھلتا (مثلاً مقامی network پر `http://192.168.x.x:3000`)، تو `AUTH_COOKIE_SECURE=false` شامل کرنا ہوگا۔ ورنہ health check تو کامیاب ہو جاتا ہے، لیکن login خاموشی سے ناکام ہو کر بار بار login screen پر واپس لے آتا ہے۔</span>

<span dir="rtl">کیا آپ کو Helm، Homebrew، Snap، winget یا deb/rpm چاہیے؟ نیچے [تنصیب](#تنصیب) ملاحظہ کریں۔</span>

## <span dir="rtl">ایک اور database tool کیوں؟</span>

<span dir="rtl">آپ managed platform پر Postgres بناتے ہیں اور وہ چالیس سیکنڈ میں تیار ہو جاتا ہے۔</span>

<span dir="rtl">پھر آپ دیکھنا چاہتے ہیں کہ اس کے اندر کیا ہے۔ اس کے لیے یا تو آپ internet پر ایک port کھولتے ہیں، یا desktop client نصب کر کے SSH tunnel بناتے ہیں، یا ہار مان کر command line پر واپس آ جاتے ہیں۔ database کو چالیس سیکنڈ لگے؛ اس میں جھانکنے کا راستہ بنانے میں پوری شام گزر گئی۔</span>

<span dir="rtl">اب اسے scale پر تصور کریں۔ application Postgres استعمال کرتی ہے، documents Mongo میں ہیں، cache Redis میں ہے، اور events ClickHouse میں ہیں۔ چار databases، چار clients، اور credentials کے چار مجموعے۔ پیر کو کوئی نیا شخص آتا ہے تو اپنی پہلی code line لکھنے سے پہلے اسے معلوم کرنا پڑتا ہے کہ کون سا data کہاں ہے، wiki اور تین private chats میں connection strings ڈھونڈنی پڑتی ہیں، VPN access کا انتظار کرنا پڑتا ہے، اور ہر engine کے لیے الگ tool نصب کرنا پڑتا ہے۔</span>

<span dir="rtl">**Databases پہلے ہی منتقل ہو چکے ہیں۔** وہ Kubernetes، managed clouds اور customer VPCs میں چلے گئے ہیں جن تک bastion کے ذریعے ہی پہنچا جا سکتا ہے۔ **لیکن انہیں پڑھنے کے tools ان کے ساتھ منتقل نہیں ہوئے۔** وہ اب بھی desktop applications ہیں: بھاری، per-seat license والے، استعمال سے پہلے install ہونے والے، اور اس مفروضے پر بنے ہوئے کہ آپ کے پاس صرف ایک database، ایک laptop اور ایک ایسا شخص ہے جو کبھی device تبدیل نہیں کرتا۔</span>

<span dir="rtl">LibreDB Studio اس کے برعکس راستہ اختیار کرتا ہے: **tool کو data کے پاس لے جایا جاتا ہے، data کو tool کے پاس نہیں۔**</span>

<span dir="rtl">اس جملے کو سنجیدگی سے لیں تو یہ محض ترجیح نہیں رہتا، بلکہ ایک specification بن جاتا ہے۔</span>

<ul dir="rtl" align="right">
<li><span dir="rtl">Editor کو browser میں چلنا چاہیے، کیونکہ data آپ کی machine میں نہیں ہے اور آپ کے teammates بھی نہیں۔</span></li>
<li><span dir="rtl">اسے phone پر بھی کھلنا چاہیے، کیونکہ جس incident کو query کی ضرورت ہو وہ آپ کے laptop کے آن ہونے کا انتظار نہیں کرتا۔</span></li>
<li><span dir="rtl">اسے infrastructure کے طور پر deploy ہونا چاہیے (container، Helm chart، Operator، one-click template)، کیونکہ database کے ساتھ رہنے والی ہر چیز اسی طرح install ہوتی ہے۔</span></li>
<li><span dir="rtl">اسے embed کیا جا سکنا چاہیے، کیونکہ editor کے لیے سب سے مفید جگہ اسی product کے اندر ہے جس نے database بنایا ہے۔</span></li>
<li><span dir="rtl">کسی چیز کو reserve نہیں کیا جا سکتا۔ آپ ہر اس environment میں per-seat licensed، tiered-features والا tool نہیں ڈال سکتے جسے آپ manage کرتے ہیں۔ <strong>اگر single sign-on کی الگ قیمت ہو، تو tool default طور پر deploy کیے جانے کے قابل نہیں رہتا۔</strong></span></li>
</ul>

> <span dir="rtl">یہاں MIT سخاوت نہیں: یہ architecture کی سخت شرط ہے۔</span>

## <span dir="rtl">بنیادی صلاحیتیں</span>

### <span dir="rtl">سولہ engines، ایک interface</span>

</div>

PostgreSQL · MySQL · Oracle · SQL Server · SQLite · libSQL · DuckDB · MongoDB · Redis · Couchbase · ClickHouse · Apache Druid · Elasticsearch · OpenSearch · Apache Trino · Apache Cassandra

<div dir="rtl" align="right">

<span dir="rtl">تمام SQL engines ایک ہی schema explorer، ER diagrams، schema comparison اور monitoring panels استعمال کرتے ہیں۔ MongoDB اور Redis SQL engines نہیں ہیں: ان میں ER diagram یا schema comparison نہیں ہوتا۔ Druid، Elasticsearch، OpenSearch اور Trino دوہری استثنائی صورتیں ہیں: HTTP پر ان کے SQL interfaces میں کوئی ایسا URI format نہیں ہے جسے یہ build سمجھ سکے، اس لیے انہیں host اور port سے configure کیا جاتا ہے، اور پیدا ہونے والی migrations اس limitation کو بیان کرتی ہیں، بجائے اس کے کہ ایسے engine کے لیے DDL گھڑ دیا جائے جس کے SQL میں column بدلنے کی statements ہی نہیں۔ Couchbase کی schema-less collections کے ساتھ بھی یہی صورت ہے۔ Search clusters کے ER diagram میں boxes تو ہوتے ہیں مگر lines نہیں: indexes foreign keys declare نہیں کرتے، اور engine model میں declare کرنے کے لیے کوئی موجود بھی نہیں۔</span>

</div>

| ڈیٹا بیس | Driver | صلاحیتیں |
| :--- | :--- | :--- |
| **PostgreSQL** | `pg` | <span dir="rtl">مکمل SQL IDE، EXPLAIN execution plans، transactions، query cancellation (`pg_cancel_backend`)</span> |
| **MySQL** | `mysql2` | <span dir="rtl">مکمل SQL IDE، EXPLAIN، transactions، query cancellation (`KILL QUERY`)</span> |
| **Oracle** | <span dir="rtl">`oracledb` (Thin موڈ)</span> | <span dir="rtl">مکمل SQL IDE، `FETCH FIRST N ROWS` کے ساتھ pagination، `V$` monitoring views، `ANALYZE TABLE`، `ALTER INDEX REBUILD`، transactions</span> |
| **SQL Server** | <span dir="rtl">`mssql` (tedious)</span> | <span dir="rtl">مکمل SQL IDE، `TOP N` / `OFFSET FETCH` کے ساتھ pagination، `sys.dm_*` DMV، `UPDATE STATISTICS`، `DBCC CHECKDB`، transactions، Azure SQL کی خودکار شناخت</span> |
| **SQLite** | <span dir="rtl">`bun:sqlite` / `node:sqlite` (runtime کے مطابق)</span> | <span dir="rtl">file یا memory میں مکمل SQL IDE</span> |
| **libSQL** | <span dir="rtl">کوئی مخصوص driver نہیں؛ براہِ راست HTTP (Hrana protocol، `POST /v2/pipeline`، port 8080)</span> | <span dir="rtl">مکمل SQL IDE۔ یہی type-id آپ کے اپنے libSQL server (`sqld`) اور Turso Cloud، دونوں سے connect کرتا ہے۔ یہ network پر SQLite dialect ہے، اور `dbstat` کے ساتھ tables اور indexes کا اصل size bytes میں دیتا ہے۔ credential password نہیں بلکہ auth token ہے۔ صرف دو maintenance operations ہیں، Reindex اور integrity check: server `VACUUM`، `ANALYZE` اور `PRAGMA optimize` کو رد کرتا ہے</span> |
| **DuckDB** | <span dir="rtl">`@duckdb/node-api` (مقامی N-API addon، ہر platform کے لیے تقریباً 68 MB)</span> | <span dir="rtl">مقامی DuckDB files یا `:memory:` پر مکمل SQL IDE، جو application کے اسی server پر چلتا ہے۔ `EXPLAIN (FORMAT JSON)` کے ساتھ physical plan tree، `duckdb_*` catalog introspection، `pragma_storage_info` کی block allocation سے table کا اصل size، اور خود driver کے `interrupt()` سے query cancellation۔ تین maintenance operations: `VACUUM`، `ANALYZE` اور `CHECKPOINT`۔ یہاں `REINDEX` syntax error ہے، جبکہ `PRAGMA integrity_check` اور `PRAGMA optimize` موجود نہیں، اس لیے پیش نہیں کیے جاتے۔ slow-query log یا sessions list نہیں: DuckDB ان میں سے کوئی بھی ظاہر نہیں کرتا، اس لیے panels 0 دکھانے کے بجائے یہ بات بتاتے ہیں۔ ایک database file کو operating system کا صرف ایک process کھول سکتا ہے (read-only mode میں بھی)، اس لیے Studio کی دوسری instance اس file کو نہیں کھول سکتی جو پہلی instance نے کھولی ہوئی ہے</span> |
| **MongoDB** | `mongodb` | <span dir="rtl">JSON query editor اور collections پر operations (find, aggregate, insert, update, delete)</span> |
| **Couchbase** | <span dir="rtl">کوئی مخصوص driver نہیں؛ براہِ راست HTTP (Query اور انتظامی REST)</span> | <span dir="rtl">مکمل SQL++ IDE، EXPLAIN، buckets، scopes اور collections explorer، `INFER` کے ذریعے field inference</span> |
| **ClickHouse** | <span dir="rtl">کوئی مخصوص driver نہیں؛ براہِ راست HTTP (SQL انٹرفیس، port 8123)</span> | <span dir="rtl">مکمل SQL IDE، JSON میں EXPLAIN tree، system tables کے ذریعے schema introspection، `OPTIMIZE TABLE`</span> |
| **Apache Druid** | <span dir="rtl">کوئی مخصوص driver نہیں؛ براہِ راست HTTP (`POST /druid/v2/sql`)</span> | <span dir="rtl">read-only SQL IDE، native query کا EXPLAIN tree، `INFORMATION_SCHEMA` سے introspection، `sys.*` کے ساتھ monitoring</span> |
| **Elasticsearch** | <span dir="rtl">کوئی مخصوص driver نہیں؛ براہِ راست HTTP (`POST /_sql?format=json`، port 9200)</span> | <span dir="rtl">read-only SQL IDE، mapping پر مبنی indexes اور fields explorer، cluster health، اور ہر index کے لیے document count اور size۔ EXPLAIN نہیں، maintenance operations نہیں، اور slow queries یا sessions panels بھی نہیں۔ Elasticsearch SQL میں `OFFSET` بھی نہیں، اس لیے results کا دوسرا page نہیں مانگا جا سکتا</span> |
| **OpenSearch** | <span dir="rtl">کوئی مخصوص driver نہیں؛ براہِ راست HTTP (`POST /_plugins/_sql`، port 9200)</span> | <span dir="rtl">Elasticsearch والا ہی provider module، وہی read-only IDE اور وہی explorer۔ یہاں `LIMIT n OFFSET m` کام کرتا ہے، اس لیے pagination دستیاب ہے</span> |
| **Apache Trino** | <span dir="rtl">کوئی مخصوص driver نہیں؛ براہِ راست HTTP (client protocol، `POST /v1/statement`، port 8080)</span> | <span dir="rtl">تمام configured catalogs پر مکمل SQL IDE، connection میں مقرر catalog کے `information_schema` کے ذریعے schema tree، `system.runtime` اور `jmx` سے monitoring، `SHOW STATS` سے اصل row counts، query cancellation اور `kill_query` کے ساتھ maintenance۔ Trino query engine ہے اور data store نہیں کرتا، اس لیے کہیں بھی primary keys، foreign keys یا indexes declare نہیں کرتا: ER diagram میں lines کے بغیر boxes ہوتے ہیں، inline editing بند رہتی ہے، اور capacity panel مصنوعی size بنانے کے بجائے catalogs دکھاتا ہے۔ ناکام statements بھی HTTP 200 کے ساتھ واپس آتی ہیں؛ اور cluster میں authentication بند ہو تب بھی plain HTTP پر password رد کر دیا جاتا ہے</span> |
| **Apache Cassandra** | <span dir="rtl">`cassandra-driver` (خالص JavaScript، native modules کے بغیر)</span> | <span dir="rtl">native protocol (port 9042) پر CQL IDE، partition اور clustering keys نشان زد keyspaces explorer، `system_views` سے summary، uptime اور چلتی ہوئی statements۔ Connection کے لیے **`localDataCenter` لازمی ہے**: اس کے بغیر driver connect کرنے سے انکار کر دیتا ہے۔ EXPLAIN نہیں (CQL grammar میں یہ keyword موجود ہی نہیں)، query cancellation نہیں (protocol میں cancel frame نہیں) اور maintenance operations نہیں (compaction، repair اور flush، `nodetool` کے JMX operations ہیں)۔ اور **یہ کوئی row count یا size نہیں دکھاتا**: Cassandra صرف disk پر پہلے سے لکھی files سے partitions کا تخمینہ (500 rows کی table کو 143 پڑھا گیا) اور MiB میں integers (19,476 bytes کی table کو `1 MiB` پڑھا جاتا ہے) دے سکتا ہے، اس لیے غلط number دکھانے کے بجائے ہم کچھ نہیں دکھاتے</span> |
| **Redis** | `ioredis` | <span dir="rtl">command editor، keys explorer، INFO پر مبنی monitoring</span> |

<div dir="rtl" align="right">

> <span dir="rtl">**Transport security cross-cutting ہے، engine پر منحصر نہیں۔** SSH tunnel provider کے connection کھولنے سے پہلے قائم ہوتا ہے، اور connection کو local endpoint کی طرف rewrite کر دیتا ہے: اسی لیے یہ engine پر منحصر نہیں اور host اور port کے ساتھ configured ہر connection پر لاگو ہوتا ہے۔ Connection string سے بھری جانے والی connections (MongoDB، Couchbase اور ClickHouse میں ممکن) میں host یا port نہیں ہوتا، اس لیے وہ tunnel سے نہیں گزرتیں؛ SQLite اور DuckDB میں بھی دونوں نہیں ہوتے۔ SSL/TLS panel فی الحال PostgreSQL، MySQL، SQL Server، Couchbase، ClickHouse، Druid، Elasticsearch، OpenSearch اور Trino پر اثر انداز ہوتا ہے؛ Trino میں یہ اختیاری نہیں کیونکہ coordinator plain HTTP پر passwords رد کرتا ہے۔ Oracle، MongoDB اور Redis اس option کو نظر انداز کرتے ہیں، اس لیے ان تینوں کا traffic encrypted ہو گا یا نہیں، اس کا انحصار connection string پر ہے، dialog کے انتخاب پر نہیں۔</span>

> <span dir="rtl">SQL کے لیے بنے interface میں Redis کو لانے کی بنیاد ایک convention ہے۔ `getSchema()` `SCAN` سے key prefixes کو "tables" میں گروپ کرتا ہے، جو block نہیں کرتا (**کبھی بھی `KEYS *` نہیں**)؛ health اور metrics `INFO` سے، جبکہ slow queries اور sessions `SLOWLOG GET` اور `CLIENT LIST` سے آتی ہیں۔</span>

### <span dir="rtl">پیشہ ورانہ SQL editor</span>

<ul dir="rtl" align="right">
<li><span dir="rtl"><strong><span dir="ltr">Monaco engine</span></strong>: وہی core جو VS Code استعمال کرتا ہے۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Schema-aware autocomplete</span></strong>: tables، columns اور keywords۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Tabbed workspace</span></strong>: ہر tab کی اپنی execution state۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Visual EXPLAIN</span></strong>: bottlenecks ڈھونڈنے کے لیے graphical execution plans۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Interactive ER diagrams</span></strong>: اصلی foreign-key edges، cardinality labels، minimap، table search اور filtering، compact mode، اور PNG اور SVG export کے ساتھ schema graph۔ خودکار hierarchical layout ELK.js کرتا ہے۔</span></li>
<li><span dir="rtl"><strong>Schema comparison اور migrations</strong>: ایک ہی یا مختلف connections کے schemas کے snapshots کو ساتھ ساتھ compare کریں۔ رنگوں کے ساتھ differences view (added، removed، modified) اور PostgreSQL، MySQL، SQLite، Oracle اور SQL Server کے لیے migration SQL کی خودکار generation، نیز ClickHouse column changes۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Snapshots timeline</span></strong>: schema snapshots کے ساتھ ایک افقی timeline۔ دو points منتخب کریں اور فوراً compare کریں، تاکہ schema کی تبدیلی کا ارتقا دیکھا جا سکے۔</span></li>
</ul>

### <span dir="rtl"><span dir="ltr">Database agent (read-only)</span></span>

<span dir="rtl">AI کی بنیادی سطح editor کے ساتھ موجود ایک **<span dir="ltr">agent panel</span>** ہے۔ کوئی مقصد دیا جاتا ہے — *"کس department میں سب سے زیادہ employees ہیں؟"*، *"یہ query اتنی slow کیوں ہے؟"* — اور Start دبایا جاتا ہے۔ Execution connected database کے لیے SQL تیار کرتی ہے، results پڑھتی ہے، اور ایک report لکھتی ہے جس کے دعوے ان results کا حوالہ دیتے ہیں۔</span>

### <span dir="rtl">دیگر model-based خصوصیات (اختیاری، اپنے model کے ساتھ)</span>

<ul dir="rtl" align="right">
<li><span dir="rtl"><strong>کسی بھی LLM کے ساتھ مطابقت</strong>: default طور پر Gemini استعمال کرتا ہے، اور OpenAI، Ollama اور OpenAI-compatible endpoint (LM Studio، LiteLLM، vLLM) کے ساتھ کام کرتا ہے۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Query security analysis</span></strong>: destructive statements (DELETE، DROP، TRUNCATE) کے لیے execution سے پہلے risk evaluation۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Query explanation</span></strong>: EXPLAIN plans کو سادہ زبان میں، optimization suggestions کے ساتھ۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Schema knowledge</span></strong>: connected database کا schema context کے طور پر بھیجا جاتا ہے، اس لیے explanation آپ کی اپنی tables اور columns کے نام لیتی ہے۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Data profiler summary</span></strong>: profiler کی فی-column statistics کا نثری خلاصہ۔ اس context میں ہر column کے <code dir="ltr">min</code> اور <code dir="ltr">max</code> شامل ہیں، جو آپ کے data کی حقیقی values ہیں؛ <a href="docs/AGENT_DATA_FLOW.md">Agent Data Flow</a> ملاحظہ کریں۔</span></li>
</ul>

### <span dir="rtl"><span dir="ltr">Data management</span></span>

<ul dir="rtl" align="right">
<li><span dir="rtl"><strong><span dir="ltr">Universal grid</span></strong>: لاکھوں rows کے لیے virtualized rendering (TanStack)۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Inline editing</span></strong>: grid میں براہِ راست values update کرنے کے لیے double-click، ان engines میں جن کے SQL میں ایک table پر row update موجود ہے (باقی میں control ظاہر نہیں ہوتا)۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Column filters</span></strong>: query دوبارہ لکھے بغیر explore کرنے کے لیے results پر text filters۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Interactive pivot table</span></strong>: client-side pivoting، پانچ aggregate functions (COUNT، SUM، AVG، MIN، MAX) اور متعلقہ SQL کی generation۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Export</span></strong>: فوری CSV اور JSON۔</span></li>
<li><span dir="rtl"><strong>آٹھ chart types</strong>: Recharts کے ساتھ bar، line، pie، area، scatter، histogram، stacked bar اور stacked area۔ hour، day، week، month یا year کے لحاظ سے grouping، اور محفوظ ہو کر دوبارہ load ہونے والی chart configurations۔</span></li>
</ul>

### <span dir="rtl">تجزیہ اور development tools</span>

<ul dir="rtl" align="right">
<li><span dir="rtl"><strong><span dir="ltr">Data profiler</span></strong>: ایک click میں table profiling، column statistics (null percentage، cardinality، minimum اور maximum، sample values) اور model سے تیار ہونے والے narrative summaries کے ساتھ۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">ORM code generator</span></strong>: tables کے اصل schema سے TypeScript interfaces، Zod schemas، Prisma models، Go structs، Python dataclasses اور Java POJOs۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Test-data generator</span></strong>: schema-aware fake data اور 30 سے زائد semantic column inferences (email، phone، name، address اور مزید)۔ MongoDB کے <code dir="ltr">insertMany</code> کے لیے INSERT statements یا JSON پیدا کرتا ہے۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Database documentation</span></strong>: اصل schema سے تیار، searchable data dictionary، model-assisted documentation اور Markdown export کے ساتھ۔</span></li>
</ul>

### <span dir="rtl">Authentication اور SSO: MIT version میں مکمل</span>

<ul dir="rtl" align="right">
<li><span dir="rtl"><strong>Authentication کے دو modes</strong>: local username/password، یا OpenID Connect (OIDC) کے ذریعے single sign-on، environment variable سے قابلِ تبدیلی۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Provider-agnostic OIDC</span></strong>: ہر OIDC-compliant provider کے ساتھ کام کرتا ہے — Auth0، Keycloak، Okta، Azure AD، Zitadel، Google اور دیگر۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">PKCE security</span></strong>: Proof Key for Code Exchange (S256) کے ساتھ Authorization Code Flow۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Automatic role mapping</span></strong>: configurable claim mapping، nested claims کے لیے dot notation کے ساتھ (مثلاً <code dir="ltr">realm_access.roles</code>)۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Provider logout</span></strong>: sign out پر مقامی JWT session اور identity provider، دونوں کی session بند ہو جاتی ہے۔</span></li>
</ul>

### <span dir="rtl">DBA کے لیے maintenance tools (صرف admin)</span>

<ul dir="rtl" align="right">
<li><span dir="rtl"><strong><span dir="ltr">Live monitoring dashboard</span></strong>: سات tabs — overview، performance، queries، sessions، tables، storage اور connection pool۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Trend charts</span></strong>: real-time metrics (connections، cache hit rate، buffer pool، deadlocks) circular-buffer history کے ساتھ، اور 5 سے 60 seconds کے درمیان configurable automatic refresh۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Threshold alerts</span></strong>: cache hit rate، connection usage، deadlocks اور buffer-pool usage کے لیے رنگ دار health indicators (healthy، warning، critical)۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">One-click maintenance</span></strong>: engine کے مطابق <code dir="ltr">VACUUM</code>، <code dir="ltr">ANALYZE</code>، <code dir="ltr">REINDEX</code>، <code dir="ltr">UPDATE STATISTICS</code>، <code dir="ltr">DBCC CHECKDB</code> اور <code dir="ltr">ALTER INDEX REBUILD</code>۔</span></li>
<li><span dir="rtl"><strong><span dir="ltr">Audit log</span></strong>: organization میں چلنے والی ہر query کی مکمل history۔</span></li>
</ul>

## <span dir="rtl">تنصیب</span>

</div>

| طریقہ | کمانڈ |
| :--- | :--- |
| **Docker** | `docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest` |
| **npx** | `npx @libredb/studio` |
| **Helm** | `helm install libredb oci://ghcr.io/libredb/charts/libredb-studio` |
| **Homebrew** | `brew trust libredb/tap && brew install libredb/tap/libredb-studio` |
| **Snap** | `sudo snap install libredb-studio` |
| **winget** | `winget install LibreDB.Studio` |
| **deb / rpm** <span dir="rtl">(server اور systemd service کے لیے)</span> | <span dir="rtl">[ریلیزز کا صفحہ](https://github.com/libredb/libredb-studio/releases/latest)</span> |
| **Desktop application** <span dir="rtl">(AppImage / deb)</span> | <span dir="rtl">[ریلیزز کا صفحہ](https://github.com/libredb/libredb-studio/releases/latest)۔ مقامی window؛ server مقامی sidecar کے طور پر چلتا ہے اور login screen نہیں آتی۔ **یہ اوپر والی قطار والا server package نہیں ہے۔**</span> |
| **Desktop application** <span dir="rtl">(Flatpak، sandbox میں)</span> | `flatpak --user remote-add --if-not-exists flatpark https://dl.flatpark.org/flatpark.flatpakrepo`<br>`flatpak --user install flatpark org.libredb.Studio` |

<div dir="rtl" align="right">

<span dir="rtl">`brew trust` صرف ایک بار چلتا ہے (Homebrew 6+ درکار ہے؛ اگر command موجود نہ ہونے کا پیغام آئے تو پہلے `brew update` چلائیں)۔ Docker، Helm اور Snap کو configuration کی ضرورت نہیں: پہلی بار چلنے پر administrator کا password بالترتیب container log، pod log اور `sudo snap logs libredb-studio` میں پرنٹ ہوتا ہے۔ ہر channel کی مکمل ہدایات (commands، configuration، systemd کے ساتھ استعمال، Docker images کا tagging model) [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) میں موجود ہیں۔</span>

<span dir="rtl">One-click deployment templates: Railway، Dokploy، CapRover، Sealos، Kubero، Cosmos، DigitalOcean Marketplace، Unraid Community Apps، Render Blueprint، Fly.io اور Koyeb۔ مکمل فہرست [`docs/CHANNELS.md`](docs/CHANNELS.md) میں موجود ہے۔</span>

<span dir="rtl">Kubernetes کے لیے OpenShift اور OLM کا Operator bundle بھی دستیاب ہے۔</span>

### <span dir="rtl">اپنے product میں شامل کریں</span>

</div>

```bash
npm i @libredb/studio
```

<div dir="rtl" align="right">

<span dir="rtl">Studio npm package کے طور پر بھی شائع ہوتا ہے، اس لیے اسے براہِ راست آپ کی application میں embed کیا جا سکتا ہے۔ اگر آپ کا product اپنے users کے لیے databases بناتا ہے تو editor کے لیے یہی سب سے مفید جگہ ہے۔</span>

## <span dir="rtl">قیمت کی لکیر کہاں ہے</span>

<span dir="rtl">Studio MIT ہے کیونکہ اسے ہر جگہ جانے کے قابل ہونا چاہیے۔ جس چیز کی قیمت لی جاتی ہے وہ libredb-platform ہے، اور اس میں دوسرا فریق اسے operate کرنے کی ذمہ داری لیتا ہے: hosting، multi-tenancy، billing اور support۔ یہ کوئی feature نہیں جسے دیوار کے پیچھے منتقل کر دیا گیا ہو۔</span>

<span dir="rtl">**Upgrade کی وجہ بنانے کے لیے کسی صلاحیت کو اس لکیر کے دوسری طرف نہیں لے جایا گیا۔** Single sign-on، RBAC، query auditing، ER diagrams، AI features اور تمام NoSQL engines MIT version میں موجود ہیں۔</span>

## <span dir="rtl">Tests اور quality</span>

<ul dir="rtl" align="right">
<li><span dir="rtl">Tests کی چھ layers: unit، API، integration، hooks، components اور end-to-end</span></li>
<li><span dir="rtl"><strong>100% line coverage</strong>، اور CI میں یہ سخت شرط ہے۔ coverage کم ہوئی تو merge رک جاتا ہے</span></li>
<li><span dir="rtl">SonarCloud quality gate</span></li>
<li><span dir="rtl">ہر release میں Node 24 اور 26 پر smoke tests</span></li>
</ul>

</div>

```bash
bun run test           # all tests
bun run test:e2e       # Playwright (requires compiling beforehand)
bun run test:coverage  # coverage report
```

<div dir="rtl" align="right">

## <span dir="rtl">دستاویزات</span>

<span dir="rtl">ابھی تفصیلی مواد صرف English میں دستیاب ہے:</span>

<ul dir="rtl" align="right">
<li><span dir="rtl"><a href="docs/ARCHITECTURE.md">Architecture</a> · <a href="docs/DATABASE_PROVIDERS.md">Database providers</a> · <a href="docs/providers/README.md">Engine reference</a></span></li>
<li><span dir="rtl"><a href="docs/API_DOCS.md">API documentation</a> · <a href="docs/OIDC.md">OIDC configuration</a> · <a href="docs/STORAGE.md">Storage layer</a></span></li>
<li><span dir="rtl"><a href="docs/HELM_CHART.md">Helm Chart</a> · <a href="docs/CHANNELS.md">Distribution channels</a> · <a href="docs/ADDING_A_PROVIDER.md">Adding a database</a></span></li>
</ul>

## <span dir="rtl">تعاون</span>

<span dir="rtl">Issues اور pull requests خوش آئند ہیں۔ آغاز [CONTRIBUTING.md](CONTRIBUTING.md) سے کریں۔</span>

<span dir="rtl">Database engine شامل کرنے کے لیے [`docs/ADDING_A_PROVIDER.md`](docs/ADDING_A_PROVIDER.md) ملاحظہ کریں۔ Code، documentation اور tests ایک ہی pull request میں ساتھ چلتے ہیں۔</span>

## <span dir="rtl">لائسنس</span>

<span dir="rtl">[MIT](LICENSE)۔ کوئی CLA نہیں، کوئی enterprise edition نہیں، اور کچھ بھی reserved نہیں۔</span>

</div>
