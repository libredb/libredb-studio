# LibreDB Studio - Enterprise Feature Roadmap (Deep Analysis)

## Context

LibreDB Studio (v0.6.11), open-source, web-based, AI-powered bir database IDE. PostgreSQL, MySQL, SQLite, MongoDB destekliyor. Kurumsal projelerde birden fazla veritabani yonetimi icin kullaniliyor.

**Mevcut Durum:** Solid bir temel var (Monaco editor, multi-tab, virtualized grid, AI assistant, monitoring, maintenance, provider abstraction). Ancak DBeaver, DataGrip, TablePlus gibi rakiplerle kiyaslandiginda enterprise adoption icin kritik eksikler mevcut.

**Hedef:** LibreDB'yi enterprise-grade bir database management tool haline getirmek. Web-based ve AI-powered olma avantajlarini kullanarak rakiplerden farklilastiracak ozellikler eklemek.

---

## FARKLI YAKLASIMLARIN KARSILASTIRILMASI

Bu planin hazirlanmasinda iki farkli perspektif analiz edildi:

1. **Competitor Gap Analysis** - DBeaver, DataGrip, TablePlus, Navicat, pgAdmin, Beekeeper Studio, Adminer, dbForge ile karsilastirma
2. **Enterprise Feature Design** - Kurumsal ihtiyaclara yonelik yeni ozellik tasarimi

Her iki analiz de ortak sonuca ulasti: Once **temel eksikleri** kapatmak, sonra **AI farklilastirma** ve **collaboration** ozellikleri ile rakiplerden ayrilmak.

---

## PHASE 0: Kritik Eksikler (Tum Rakiplerde Var, LibreDB'de Yok) <COMPLETED>

> Bu ozellikler olmadan ciddi bir enterprise kullanici aday bile olmaz. Oncelikli olarak bunlar tamamlanmali.

### 0.1 Gercek Connection Testing
- **Sorun:** `ConnectionModal.tsx` satir 33'te `setTimeout(1500)` ile sahte bekleme var, gercek test yok
- **Cozum:** `POST /api/db/test-connection` route ekle, `provider.connect()` + `provider.disconnect()` cagir
- **Dosyalar:** `ConnectionModal.tsx`, yeni route `api/db/test-connection/route.ts`
- **Karmasiklik:** Dusuk (1-2 gun)

### 0.2 Connection Editing
- **Sorun:** Mevcut baglantilari duzenlemek icin silip yeniden olusturmak gerekiyor
- **Cozum:** ConnectionModal'a edit mode ekle, `Sidebar.tsx`'e "Edit" action ekle
- **Dosyalar:** `ConnectionModal.tsx`, `Sidebar.tsx`, `Studio.tsx`
- **Karmasiklik:** Dusuk (<1 gun)

### 0.3 Connection List and information Export and Import (Tum DB Tipleri)
- **Sorun:** Sadece MongoDB connection string destekliyor. PostgreSQL/MySQL URL'leri (`postgres://user:pass@host:5432/db`) parse edilemiyor
- **Cozum:** URL parser ekle, ConnectionModal'da "Paste Connection String" butonu
- **Dosyalar:** `ConnectionModal.tsx`, yeni utility `src/lib/connection-string-parser.ts`
- **Karmasiklik:** Dusuk (1 gun)

### 0.4 SSL/TLS Configuration UI
- **Sorun:** Provider'larda temel SSL destegi var ama kullaniciya ayar yapma imkani yok. Cloud DB'ler (AWS RDS, Azure, GCP) SSL gerektiriyor
- **Cozum:** `DatabaseConnection` type'a SSL alanlari ekle (sslMode, caCert, clientCert, clientKey). ConnectionModal'a SSL paneli ekle
- **Dosyalar:** `src/lib/types.ts`, `ConnectionModal.tsx`, `db-ui-config.ts`, SQL provider'lar
- **Karmasiklik:** Orta (2-3 gun)

### 0.5 SSH Tunnel Destegi
- **Sorun:** Uretim veritabanlari genellikle firewall arkasinda, SSH bastion uzerinden erisilebilir. SSH tunnel olmadan enterprise DB'lere baglanilamaz
- **Cozum:** `ssh2` kutuphanesi ile server-side tunnel. `DatabaseConnection`'a SSH alanlari ekle. Factory'de tunnel olustur, sonra provider'a bagla
- **Dosyalar:** `src/lib/types.ts`, `src/lib/db/factory.ts`, `ConnectionModal.tsx`, yeni `src/lib/ssh/tunnel.ts`
- **Karmasiklik:** Orta (3-5 gun)

### 0.6 Query Cancellation / Abort
- **Sorun:** Uzun suren sorguyu durdurmak imkansiz. Tab kitlenir, server kaynaklari tuketilir
- **Cozum:** Client'ta `AbortController`, server'da query PID/thread takibi. PostgreSQL: `pg_cancel_backend()`, MySQL: `KILL QUERY`. "Cancel" butonu ekle
- **Dosyalar:** `Studio.tsx`, `src/app/api/db/query/route.ts`, provider'lara `cancelQuery()` metodu
- **Karmasiklik:** Orta (2-3 gun)

### 0.7 Transaction Control (BEGIN/COMMIT/ROLLBACK)
- **Sorun:** Her sorgu auto-commit. DBA'ler coklu ifadeyi tek transaction icinde calistirmak istiyor
- **Cozum:** Session kavramini tani. Dedicated connection (pool disinda) ile transaction state tracking. Toolbar'a BEGIN/COMMIT/ROLLBACK butonlari
- **Dosyalar:** `DatabaseProvider` interface, `src/app/api/db/query/route.ts`, `Studio.tsx`, `QueryEditor.tsx`
- **Karmasiklik:** Orta-Yuksek (3-5 gun)

---

## PHASE 1: Enterprise Foundation (Guvenlik, Kimlik, Kalicilik)

> Enterprise deployment icin olmazsa olmaz. Bu phase olmadan collaboration ve governance ozellikleri eklenemez.

### 1.1 User Identity ve Team Management
User JWT and Outh2 support like Keycloak, Auth0, Okta, etc.
- **Sorun:** Iki hardcoded sifre (admin/user) herkes tarafindan paylasiliyor. 50 muhendis ayni "admin" sifresini kullaniyor
- **Cozum:** Gercek kullanici sistemi (users tablosu, invite flow, profil sayfasi, session yonetimi). Mevcut JWT altyapisi genisletilir
- **Fayda:** Security teams (compliance), tum kullanicilar (kisisellestirilmis deneyim)
- **Dosyalar:** `src/lib/auth.ts` (UserPayload genisletme), `src/middleware.ts`, yeni `src/lib/users/`, yeni routes `/api/auth/register`, `/api/auth/invite`
- **Karmasiklik:** Yuksek

### 1.2 Server-Side State Persistence (Connection Vault)
- **Sorun:** Tum veriler localStorage'da - browser temizlenince kaybolur, cihazlar arasi paylasim yok, sifreleme yok
- **Cozum:** Metadata DB (self-hosted icin SQLite, veya configurable Postgres). Connection credential'lari AES-256-GCM ile sifreleme. `storage.ts` API korunur, sadece backend degisir
- **Fayda:** Cross-device erisim, encrypted credential storage, team paylasimi
- **Dosyalar:** `src/lib/storage.ts` (async backend), yeni `src/lib/storage-server.ts`, yeni routes `/api/connections`, `/api/saved-queries`, `/api/history`
- **Bagimlilikar:** 1.1 (User Identity)
- **Karmasiklik:** Yuksek

### 1.3 Connection-Level Access Control (RBAC v2)
- **Sorun:** Giris yapan herkes her baglantiya erisebiliyor. Production vs staging ayrimi yok
- **Cozum:** Connection bazli roller (viewer: sadece SELECT, editor: DML, owner: full). Query policy engine (SQL parse edip ifade tipini tespit et). Environment tagging (production/staging/dev)
- **Dosyalar:** `src/app/api/db/query/route.ts` (enforcement point), yeni `src/lib/permissions/`
- **Bagimlilikar:** 1.1, 1.2
- **Karmasiklik:** Yuksek

### 1.4 Audit Log
- **Sorun:** Kim, ne zaman, hangi sorguyu calistirdi - takip edemiyor. SOX/HIPAA/GDPR compliance icin zorunlu
- **Cozum:** Server-side append-only log. User, connection, query, timestamp, execution time, row count, client IP. Immutable storage + viewer UI + export
- **Dosyalar:** Yeni `src/lib/audit/`, yeni route `/api/audit`, yeni sayfa `/admin/audit-log`
- **Bagimlilikar:** 1.1, 1.2
- **Karmasiklik:** Orta

---

## PHASE 2: Collaboration ve Workflow (Web Avantaji)

> Desktop araclarin YAPMADIGI seyler. LibreDB'nin web-based olmasi burada buyuk avantaj.

### 2.1 Shared Query Workspaces
- **Sorun:** DBA faydali bir sorgu yaziyor, Slack'e yapistiyor. Paylasilabilir, yorumlanabilir sorgu koleksiyonu yok
- **Cozum:** Workspace kavrami (team genelinde gorulebilir sorgu koleksiyonlari). Folder organizasyonu, URL ile paylasim, versiyon gecmisi, fork, yorum
- **Dosyalar:** Mevcut `SavedQueries.tsx` genisletilir, yeni `WorkspaceExplorer.tsx`, `QueryComments.tsx`
- **Bagimlilikar:** 1.1, 1.2
- **Karmasiklik:** Yuksek

### 2.2 Query Review ve Approval Workflow
- **Sorun:** Production'da tehlikeli sorgulari engelleyecek mekanizma yok. ALTER TABLE, bulk DELETE gibi islemler peer review gerektirmeli
- **Cozum:** "Request Review" butonu, onay kuyrugu, diff gorunumu, otomatik tehlikeli pattern tespiti, email/webhook bildirimi. Onaylanan sorgular imzali hash ile korunur
- **Dosyalar:** Yeni `ReviewQueue.tsx`, `ReviewDetail.tsx`, routes `/api/reviews`
- **Bagimlilikar:** 1.1, 1.2, 1.3
- **Karmasiklik:** Yuksek

### 2.3 Notifications ve Activity Feed
- **Sorun:** Takimin veritabanlari uzerindeki faaliyetlerinden haberdar olmak mumkun degil
- **Cozum:** In-app bildirim (bell icon), activity feed, event tipleri (sorgu, schema degisikligi, maintenance, review, slow query, health alert). Webhook entegrasyonu (Slack, Discord, PagerDuty)
- **Dosyalar:** Yeni `NotificationCenter.tsx`, yeni `src/lib/notifications/`, SSE/WebSocket
- **Bagimlilikar:** 1.1, 1.2
- **Karmasiklik:** Orta

---

## PHASE 3: AI-Powered Intelligence (Rakiplerden Farklilasma)

> Hicbir rakibin yapmadigi ozellikler. LibreDB'nin mevcut LLM altyapisini kullanarak genuine database intelligence.

### 3.1 Multi-Turn Conversational AI
- **Sorun:** Mevcut AI tek turlu - her seferinde bagimsiz bir istek. "Simdi bunu da ekle..." veya "Bu sorguyu optimize et" diyemiyor
- **Cozum:** Tab basina konusma gecmisi. `LLMMessage[]` biriktirilir. Onceki sorgulara ve sonuclarina referans verebilir. Context window yonetimi (eski mesajlari ozetleme)
- **Mevcut Altyapi:** `LLMMessage[]` ve `role` zaten `/src/lib/llm/types.ts`'de tanimli. API route'u `messages[]` kabul edecek sekilde genisletilir
- **Dosyalar:** `src/app/api/ai/chat/route.ts`, yeni `AIConversation.tsx`, `QueryEditor.tsx`
- **Karmasiklik:** Orta

### 3.2 AI Index Advisor
- **Sorun:** Eksik veya verimsiz index'ler yavas sorgularin #1 nedeni. Cogu developer EXPLAIN ciktilarini yorumlayamiyor
- **Cozum:** Slow query'leri + EXPLAIN plan'lari + schema bilgisini analiz et, index onerisi sun. `CREATE INDEX` statement'lari uret. Etki tahmini goster
- **Mevcut Altyapi:** `VisualExplain.tsx` zaten EXPLAIN parse ediyor, `getSlowQueries()` ve `getIndexStats()` mevcut
- **Dosyalar:** Yeni `src/lib/ai/index-advisor.ts`, yeni `IndexAdvisor.tsx`, route `/api/ai/index-advisor`
- **Karmasiklik:** Orta

### 3.3 AI Schema Design Assistant
- **Sorun:** Veritabani schema tasarimi uzmanlik gerektiriyor. Junior developer'lar problematik schemalar olusturuyor
- **Cozum:** Dogal dil -> DDL ("SaaS uygulamasi icin users, organizations, billing"). Mevcut `SchemaDiagram.tsx` ile gorsel onizleme. Mevcut schema review/iyilestirme onerisi. Migration SQL uretimi
- **Dosyalar:** `CreateTableModal.tsx` genisletilir, yeni `SchemaDesigner.tsx`, route `/api/ai/schema-design`
- **Karmasiklik:** Orta

### 3.4 Natural Language to Query (NL2SQL)
- **Sorun:** Teknik olmayan kullanicilar (product manager, analist) SQL yazamiyor ama veriye ihtiyac duyuyor
- **Cozum:** Ozel NL2SQL modu ("Bu ayin en cok gelir getiren 10 musterisini goster"). Schema-aware, belirsizlikte aciklayici sorular sorar. Sonuc hem sorgu hem data olarak gosterilir
- **Dosyalar:** Yeni `NaturalLanguageQuery.tsx`, mevcut LLM altyapisi, mevcut `ResultsGrid.tsx`
- **Karmasiklik:** Orta

### 3.5 AI Query Safety Analysis (Pre-Execution)
- **Sorun:** DELETE/DROP/TRUNCATE calistirmadan once ne olacagini tahmin etmek zor
- **Cozum:** Tehlikeli sorguyu AI'ya analiz ettir: "Bu DELETE orders tablosundaki ~12,000 satiri silecek ve order_items'daki 34,000 satira cascade edecek." Risk degerlendirmesi + onay ekrani
- **Mevcut Altyapi:** AI streaming + schema context zaten mevcut
- **Karmasiklik:** Orta (2-3 gun)

---

## PHASE 4: Gelismis Database Islemleri (DBA Productivity)

### 4.1 Schema Migration Manager
- **Sorun:** Production'da schema degisiklikleri riskli. Migration planlama, review, test, rollback gerektiriyor
- **Cozum:** Versiyonlanmis SQL migration dosyalari (up/down). Schema diff'ten migration uretimi. Dry run modu. Git ile export
- **Dosyalar:** Yeni `src/lib/migrations/`, routes `/api/migrations`, sayfa `/migrations`
- **Bagimlilikar:** 1.2, 1.3
- **Karmasiklik:** Yuksek

### 4.2 Multi-Connection Query Execution
- **Sorun:** Ayni sorguyu birden fazla veritabaninda calistirmak gerekiyor (tum prod instance'larda tablo boyutlarini kontrol et)
- **Cozum:** Birden fazla baglanti secip tek sorgu calistir. Paralel calistirma, per-connection sonuclar. "Fleet" kavrami
- **Dosyalar:** Yeni route `/api/db/multi-query`, yeni `MultiQueryResults.tsx`
- **Bagimlilikar:** 1.2
- **Karmasiklik:** Orta

### 4.3 Scheduled Queries (Cron Jobs)
- **Sorun:** Tekrarlanan islemler (gunluk rapor, haftalik temizlik) icin harici cron gerektiriyor
- **Cozum:** Cron syntax ile zamanlama. Sonucu email/webhook/store. Calistirma gecmisi ve failure alert
- **Dosyalar:** Yeni `src/lib/scheduler/`, routes `/api/schedules`, sayfa `/schedules`
- **Bagimlilikar:** 1.1, 1.2, 2.3
- **Karmasiklik:** Yuksek

### 4.4 Database Comparison ve Sync
- **Sorun:** Dev/staging/production arasinda schema ve data drift. Migration script'leri manuel olusturuluyor
- **Cozum:** Tablo-tablo, kolon-kolon schema karsilastirma. Renk kodlu diff. ALTER script uretimi. Data karsilastirma (row count, checksum)
- **Dosyalar:** Yeni `src/lib/comparison/`, `ComparisonView.tsx`, Monaco diff editor kullanimi
- **Bagimlilikar:** 1.2
- **Karmasiklik:** Yuksek

### 4.5 Multi-Statement Execution
- **Sorun:** Server tek sorgu olarak calistirir. Coklu ifade iceren script'ler (migration, seed) duzenli calistirilemiyor
- **Cozum:** Statement splitter (string/comment icindeki semicolonlari handle et). Sirayli calistirma, per-statement sonuclar
- **Dosyalar:** `src/app/api/db/query/route.ts`, yeni `src/lib/sql/statement-splitter.ts`
- **Karmasiklik:** Orta (3-4 gun)

---

## PHASE 5: Developer Experience

### 5.1 Command Palette (Cmd+K)
- **Sorun:** Power user'lar icin keyboard-first navigasyon yok. VS Code/DataGrip kullanicilari command palette bekliyor
- **Cozum:** `cmdk` paketi zaten `package.json`'da. Tablolar, saved query'ler, history, connection'lar, action'lar arasinda fuzzy arama
- **Mevcut Altyapi:** Shadcn/UI command component hazir
- **Dosyalar:** Yeni `CommandPalette.tsx`, `Studio.tsx`'e global keyboard listener
- **Bagimlilikar:** Yok
- **Karmasiklik:** Dusuk (1-2 gun)

### 5.2 Query Snippets ve Template Library
- **Sorun:** Yaygin sorgu patternleri (pagination, search, aggregation) surekli tekrar yaziliyor
- **Cozum:** Built-in + custom snippet library. Parametreli template'ler (`{{table}}`, `{{column}}`). Monaco autocomplete entegrasyonu
- **Mevcut Altyapi:** `QueryEditor.tsx`'de 6 hardcoded snippet var (satir 53), dinamik sisteme donusturulur
- **Dosyalar:** `QueryEditor.tsx`, yeni `SnippetLibrary.tsx`, yeni `src/lib/snippets/`
- **Karmasiklik:** Dusuk-Orta

### 5.3 Database Documentation Generator
- **Sorun:** Veritabani dokumantasyonu her zaman eski. Canli schema'dan otomatik uretim gerekiyor
- **Cozum:** Schema'dan auto-doc. AI ile tablo/kolon aciklamalari. Searchable data dictionary. Markdown/HTML/PDF export. Kullanici annotation'lari
- **Mevcut Altyapi:** `getSchema()` zaten tum bilgiyi dondurur, `SchemaDiagram.tsx` mevcut
- **Dosyalar:** Yeni `DatabaseDocs.tsx`, route `/api/ai/describe-schema`
- **Karmasiklik:** Orta

### 5.4 Data Filtering / WHERE Clause Builder
- **Sorun:** ResultsGrid'de kolon filtreleme yok. Veri filtrelemek icin SQL yazmak gerekiyor
- **Cozum:** Kolon basliklarinda filtre ikonu. Gorsel WHERE builder. Filtre kombinasyonlari (AND/OR)
- **Dosyalar:** `ResultsGrid.tsx`
- **Karmasiklik:** Orta (3-4 gun)

### 5.5 SQL Export (INSERT, DDL)
- **Sorun:** Export sadece CSV/JSON destekliyor. SQL export (INSERT statements, CREATE TABLE) yok
- **Cozum:** Export modalina "SQL INSERT" ve "DDL (CREATE TABLE)" secenekleri ekle
- **Dosyalar:** `Studio.tsx` (export fonksiyonu satir 228-253)
- **Karmasiklik:** Dusuk (1-2 gun)

### 5.6 Connection Groups / Color Coding
- **Sorun:** Connection'lar duz liste. Production/staging/dev ayrimi gorsel olarak yok. Yanlis DB'de sorgu calistirma riski
- **Cozum:** Folder/group kavrami. Renk kodlama (kirmizi=prod, sari=staging, yesil=dev). Environment etiketi
- **Dosyalar:** `Sidebar.tsx`, `src/lib/types.ts` (DatabaseConnection'a group, color alanlari)
- **Karmasiklik:** Dusuk (1-2 gun)

### 5.7 Tab Renaming
- **Sorun:** Tab'lar otomatik isimlendirilir ("Query 1"), kullanici adi veremez
- **Cozum:** Double-click ile tab adi duzenleme
- **Dosyalar:** `Studio.tsx`
- **Karmasiklik:** Dusuk (<1 gun)

---

## PHASE 6: Observability ve Operations

### 6.1 Alerting ve Threshold Rules
- **Sorun:** Monitoring dashboard mevcut durumu gosteriyor ama bir sey ters gittiginde bildirim yok
- **Cozum:** Alert kurallari: metrik + kosul + esik + aksiyon. "Cache hit ratio < 90% icin 5 dakika" -> Email + Slack. Alert gecmisi, sessizlestirme, dashboard widget
- **Dosyalar:** Yeni `src/lib/alerting/`, `AlertManager.tsx`, `AlertBanner.tsx`
- **Bagimlilikar:** 2.3, 1.2
- **Karmasiklik:** Orta

### 6.2 Connection Health Monitor (Background)
- **Sorun:** Saglik kontrolleri manuel - kullanici Health dashboard'a gitmeli. Baglantilar sessizce fail olabiliyor
- **Cozum:** Tum aktif baglantilara background ping (30sn). Sidebar'da yesil/sari/kirmizi nokta. Auto-reconnect. Latency gosterimi
- **Mevcut Altyapi:** Provider'da `isConnected()` zaten var
- **Dosyalar:** `Sidebar.tsx`, yeni route `/api/db/ping`, SSE
- **Karmasiklik:** Dusuk-Orta

### 6.3 Performance Baseline ve Anomaly Detection
- **Sorun:** Baseline olmadan mevcut performansin normal mi bozuk mu oldugunu bilmek mumkun degil
- **Cozum:** Periyodik metrik toplama, istatistiksel baseline, AI-powered anomaly detection, kapasite tahmini
- **Bagimlilikar:** 4.3, 1.2
- **Karmasiklik:** Yuksek

---

## PHASE 7: Integration ve Extensibility

### 7.1 REST API (Harici Entegrasyon)
- **Sorun:** CI/CD, monitoring sistemleri, custom script'ler LibreDB ile programatik iletisim kuramiyor
- **Cozum:** API key auth, rate limiting, OpenAPI/Swagger dokumantasyonu. Mevcut route'lar zaten var, sadece API key auth ve dokumantasyon gerekiyor
- **Dosyalar:** Yeni middleware, yeni `src/lib/api-keys/`, sayfa `/settings/api-keys`
- **Karmasiklik:** Orta

### 7.2 Plugin System
- **Sorun:** Her takimin ozel ihtiyaci var. Yeni DB provider'lar, UI panelleri, export formatlari plugin olarak eklenebilmeli
- **Cozum:** Plugin API (DB provider, LLM provider, export format, UI panel). Plugin registry. Dinamik yukleme
- **Mevcut Altyapi:** Strategy Pattern zaten mevcut, `db-ui-config.ts` registry hazir
- **Karmasiklik:** Yuksek

### 7.3 Git Integration
- **Sorun:** Sorgulari kod gibi yonetmek (versiyonlama, branch, PR, CI) mumkun degil
- **Cozum:** Git repo baglama, .sql dosyalari olarak sync, push/pull, branch destegi
- **Bagimlilikar:** 2.1
- **Karmasiklik:** Yuksek

---

## PHASE 8: Yeni Database Destekleri

### 8.1 Redis Provider
- **Sorun:** Redis `DatabaseType` union'da ve `db-ui-config.ts`'de zaten tanimli ama "not yet implemented"
- **Cozum:** `src/lib/db/providers/keyvalue/redis.ts`. JSON-based query format. Key browser, TTL, memory usage. Monitoring: memory, clients, keyspace
- **Mevcut Altyapi:** Factory switch case (satir 92), db-ui-config entry (satir 46), DatabaseType'da 'redis' zaten var
- **Karmasiklik:** Orta

### 8.2 ClickHouse Provider
- **Sorun:** En populer open-source OLAP veritabani. Enterprise analytics takimlari tarafindan yaygin kullaniliyor
- **Cozum:** `SQLBaseProvider` extend eder. ClickHouse-specific SQL (FINAL, PREWHERE, SAMPLE). MergeTree awareness
- **Karmasiklik:** Orta

### 8.3 DynamoDB Provider
- **Sorun:** AWS'nin en populer managed NoSQL DB'si. AWS uzerinde calisan takimlar icin onemli
- **Cozum:** `BaseDatabaseProvider` extend eder. JSON-based query (MongoDB benzeri). GSI/LSI awareness
- **Karmasiklik:** Orta

---

## PHASE 9: Rol-Bazli Yaratici Ozellikler (Rakiplerin Onunde)

> Bu ozellikler LibreDB'yi HICBIR rakibin yapamadigi bir konuma tasir. Her biri belirli bir rolun gunluk yasadigi sorunu cozer.

### --- SQL DATA ANALYST ---

### 9.1 AI-Powered Data Profiler
- **Rol:** Data Analyst
- **Sorun:** Analistler zamanlarinin %30-60'ini veriyi anlamak icin harcar. Her kolon icin `COUNT(DISTINCT)`, `MIN/MAX`, `NULL %` yazmalari gerekiyor
- **Cozum:** Tek tikla tablo profili: kolon dagilimlari, kardinalite, null orani, outlier'lar, pattern tespiti. AI ile dogal dil ozeti ("created_at kolonunda Mart-Temmuz 2024 arasi bosluk var - servis kesintisi olabilir")
- **Mevcut Altyapi:** `getSchema()` mevcut, Recharts histogram icin hazir, LLM streaming mevcut
- **Dosyalar:** Provider'lara `profileTable()` metodu, yeni route `/api/db/profile`, yeni `DataProfiler.tsx` (bottom panel mode)
- **Fark:** DBeaver/DataGrip temel kolon istatistikleri gosterir ama AI narrative yorumlama yapmaz
- **Karmasiklik:** Orta-Yuksek

### 9.2 Interactive Pivot Table Builder
- **Rol:** Data Analyst, Business Analyst
- **Sorun:** `GROUP BY` / `CASE WHEN` pivot yazmak karmasik SQL gerektiriyor. Spreadsheet kullanicilari drag-and-drop beklyor
- **Cozum:** Herhangi bir sorgu sonucunu client-side pivotlama. Drag-and-drop ile rows/columns/values/filters. "SQL Uret" butonu AI ile denk SQL kodunu uretir (analist SQL ogrenir)
- **Dosyalar:** Yeni `PivotTable.tsx`, yeni `src/lib/pivot-engine.ts` (client-side aggregation)
- **Fark:** Hicbir DB IDE pivot table desteklemiyor. BI araclari (Metabase, Superset) ayri kurulum gerektiriyor
- **Karmasiklik:** Orta

### 9.3 Smart Query Notebook (Jupyter-benzeri)
- **Rol:** Data Analyst, Developer
- **Sorun:** Iliskili sorgular dizisi ("once tablo incele, sonra join yaz, sonra aggregate et") belgelemiyor, paylasmiyor
- **Cozum:** Markdown + SQL notebook. Markdown hucreleri (dokumantasyon) ve Query hucreleri (calistir + inline sonuc). Hucre degiskenleri (`{{onceki.max_date}}`). Markdown export. AI ile sorgular arasi aciklama uretimi
- **Dosyalar:** Yeni `Notebook.tsx`, `NotebookCell.tsx`, `src/lib/notebook/`, `storage.ts` genisletme
- **Fark:** Jupyter SQL magic'i Python gerektiriyor. Hicbir DB IDE'de native notebook yok
- **Karmasiklik:** Yuksek (en farklilastirici ozellik)

### --- DEVELOPER (Backend/Full-Stack) ---

### 9.4 Schema-Aware ORM Code Generator
- **Rol:** Backend Developer, Full-Stack Developer
- **Sorun:** DB schema'sini TypeScript interface, Prisma model, Go struct, Python dataclass'a cevirme tekrarli ve hata yapar
- **Cozum:** Canli schema'dan tek tikla kod uretimi. Ciktilar: TypeScript interfaces, Zod schemas, Prisma models, Go structs, Python dataclasses, Java POJOs. AI ile karmasik iliskiler icin gelismis uretim. Monaco'da syntax-highlighted preview
- **Mevcut Altyapi:** `TableSchema[]` zaten tum kolon/tip/FK bilgisini iceriyor
- **Dosyalar:** Yeni `src/lib/codegen/` (template engine + tip eslesme tablolari), `CodeGenerator.tsx`, SchemaExplorer'a context menu
- **Fark:** Prisma sadece Prisma icin, DB IDE'lerin hicbiri bunu yapmiyor
- **Karmasiklik:** Orta

### 9.5 Intelligent Test Data Generator (Faker)
- **Rol:** Backend Developer, QA Engineer
- **Sorun:** Test verisi olusturmak icin INSERT yazmak veya harici araclar kullanmak gerekiyor
- **Cozum:** Schema'dan otomatik test verisi. AI kolon adlarindan semantik anlam cikarir (email -> valid email, phone -> telefon no). FK constraintlerine saygi duyar. Onizleme + calistirma. MongoDB icin `insertMany` JSON
- **Dosyalar:** Yeni `TestDataGenerator.tsx`, `src/lib/faker/` (lightweight faker engine + inferrer), SchemaExplorer context menu
- **Fark:** Mockaroo harici servis, schema bilmez. LibreDB canli schema + AI + dogrudan INSERT
- **Karmasiklik:** Orta

### 9.6 AI Query Explainer ("Explain Like I'm 5")
- **Rol:** Tum roller (ozellikle junior developer ve analyst)
- **Sorun:** EXPLAIN ciktisi DBA'ler icin anlamli ama cogu developer ve analist icin opak. "Seq Scan" gordugunde ne yapmasi gerektigini bilmiyor
- **Cozum:** EXPLAIN plan + orijinal sorgu + schema kontekstini AI'ya gonder. AI dondurur: (1) duz Turkce/Ingilizce aciklama, (2) somut oneri ("orders.customer_id'ye index ekle"), (3) optimize edilmis sorgu. "Bunu Dene" butonu optimize sorguyu editor'e yukler
- **Mevcut Altyapi:** `VisualExplain.tsx` zaten EXPLAIN parse ediyor
- **Dosyalar:** `VisualExplain.tsx`'e AI tab, yeni route `/api/ai/explain`
- **Fark:** Hicbir arac EXPLAIN'i AI ile dogal dile cevirmiyor
- **Karmasiklik:** Dusuk-Orta

### 9.7 Schema Change Impact Analyzer
- **Rol:** Developer, Data Engineer
- **Sorun:** DDL calistirmadan once etkisini bilmek mumkun degil ("NOT NULL eklesem kac satir fail olur?", "Bu indexi silsem hangi sorgular yavaşlar?")
- **Cozum:** DDL ifadesini parse et, canli schema'yi incele, etki raporu uret. AI ile cascade etkileri, kilit suresi tahmini, bagimlı view/index tespiti. Read-only dogrulama sorgulari (`COUNT(*) WHERE col IS NULL`)
- **Dosyalar:** Yeni `ImpactAnalyzer.tsx`, `/api/ai/impact`, `/api/db/impact`, `src/lib/sql/ddl-parser.ts`
- **Fark:** Hicbir DB IDE pre-migration impact analysis yapmiyor
- **Karmasiklik:** Orta-Yuksek

### --- DATA ENGINEER ---

### 9.8 Cross-Database Query Federation
- **Rol:** Data Engineer, Backend Developer
- **Sorun:** Farkli DB'lerdeki verileri karsilastirmak gerekiyor ("PG warehouse'daki kullanici sayisi MongoDB app DB ile uyusuyor mu?")
- **Cozum:** Iki baglanti sec, her birine sorgu yaz, paralel calistir, client-side join/compare. Inner/left/full outer join ve "diff" (A'da olup B'de olmayan satirlar). AI join key onerisi
- **Dosyalar:** Yeni `CrossDatabaseCompare.tsx`, `src/lib/federation/join-engine.ts`, `src/lib/federation/diff-engine.ts`
- **Fark:** DBeaver bile cross-DB join yapamiyor. Trino/Presto altyapi kurulumu gerektiriyor
- **Karmasiklik:** Yuksek

### 9.9 Data Quality Rules Engine
- **Rol:** Data Engineer, Data Analyst
- **Sorun:** Veri kalitesi dogrulamalari ("NULL olan zorunlu alanlar var mi?", "Email'ler gecerli mi?") icin ad-hoc sorgular tekrar tekrar yaziliyor
- **Cozum:** Gorsel kural tanimlama (null check, uniqueness, regex, range, referential integrity, custom SQL). Kurallari kaydet, validation suite olarak calistir. AI kural onerisi (kolon adinda "email" varsa regex dogrulama oner)
- **Dosyalar:** Yeni `DataQualityRules.tsx`, `src/lib/data-quality/` (rule-types, rule-compiler), route `/api/db/validate`
- **Fark:** Great Expectations/dbt tests Python/YAML gerektiriyor. LibreDB'de gorsel, no-code, AI-powered
- **Karmasiklik:** Orta-Yuksek

### --- DATABASE ADMIN (DBA) ---

### 9.10 AI Query Performance Autopilot
- **Rol:** DBA
- **Sorun:** Yavas sorgu loglarini analiz etmek, EXPLAIN ile korelasyon kurmak, index onerisi uretmek saatler aliyor
- **Cozum:** Slow query'ler + EXPLAIN planlari + tablo istatistikleri + index kullanim oranlarini AI'ya besle. Siralanmis, aksiyona donusturulebilir optimizasyon raporu. "Fix Uygula" butonu ile tek tikla index olusturma/sorgu yeniden yazma
- **Mevcut Altyapi:** `getSlowQueries()`, `getIndexStats()`, `VisualExplain.tsx` mevcut
- **Dosyalar:** Yeni `QueryAutopilot.tsx`, route `/api/ai/query-autopilot`, `src/hooks/use-query-autopilot.ts`
- **Fark:** Hicbir arac slow query + EXPLAIN + schema + AI'yi tek pipeline'da birlestirmiyor
- **Karmasiklik:** Orta-Yuksek

### 9.11 Lock Dependency Graph (Canli)
- **Rol:** DBA
- **Sorun:** Kilit sorunlarinda `pg_locks` + `pg_stat_activity` ile bagimliliklari anlamak zor. Flat tablo gorunumu yaniltici
- **Cozum:** ReactFlow ile canli yonlu graf. Session'lar node, kilit beklemeleri edge. Renk kodlu kilit tipleri. 5sn auto-refresh. "Kill Session" butonu node uzerinde. Deadlock replay animasyonu
- **Mevcut Altyapi:** ReactFlow (`@xyflow/react`) zaten SchemaDiagram'da kullaniliyor
- **Dosyalar:** Route `/api/db/locks`, yeni `monitoring/tabs/LocksTab.tsx`, provider'lara `getLockDependencies()` metodu
- **Fark:** Hicbir DB IDE lock'lari graf olarak gostermiyor
- **Karmasiklik:** Orta

### 9.12 Smart Vacuum Scheduler + Bloat Forecasting
- **Rol:** DBA (PostgreSQL)
- **Sorun:** Autovacuum ayarlari zor. Tablolarda dead tuple birikimi performansi bozuyor. Yuzlerce tabloyu izlemek manuel olarak imkansiz
- **Cozum:** Bloat trend grafigi (Recharts), dead tuple buyume hizi ile lineer regresyon tahmini ("Bu tablo 3 gun icinde %30 bloat'a ulasacak"). Optimum vacuum zamanlama onerisi. AI ile dogal dil tavsiye
- **Mevcut Altyapi:** `TablesTab.tsx` zaten `lastVacuum`, `deadRowCount`, `bloatRatio` gosteriyor
- **Dosyalar:** Yeni `monitoring/tabs/VacuumSchedulerTab.tsx`, `src/lib/vacuum-forecast.ts`
- **Karmasiklik:** Orta

### --- DEVOPS ENGINEER ---

### 9.13 Multi-Environment Schema Diff + AI Migration
- **Rol:** DevOps, DBA
- **Sorun:** Dev/staging/production arasinda schema drift tespiti CLI araci gerektiriyor (`pg_dump --schema-only` + diff)
- **Cozum:** Iki baglanti sec, schema fetch et, gorsel diff (Monaco diff editor). AI ile ALTER/CREATE migration SQL'i uret. "Apply Migration" butonuyla hedef DB'ye uygula
- **Mevcut Altyapi:** `getSchema()` tum provider'larda mevcut, Monaco diff editor built-in
- **Dosyalar:** Route `/api/db/schema-diff`, yeni `SchemaDiff.tsx`, `src/lib/schema-diff.ts`
- **Karmasiklik:** Orta

### 9.14 Prometheus-Compatible Metrics Export
- **Rol:** DevOps, SRE
- **Sorun:** LibreDB monitoring verileri sadece web UI uzerinden gorunur. Prometheus/Grafana/Datadog ile entegrasyon yok
- **Cozum:** `GET /api/db/metrics` endpoint'i Prometheus exposition formatinda. Tum DB turleri icin unified metrikler. Grafana dashboard template'i. API key veya JWT auth
- **Mevcut Altyapi:** `getMonitoringData()` tum provider'larda mevcut, zengin metrikler donuyor
- **Dosyalar:** Route `/api/db/metrics`, `src/lib/metrics-formatter.ts`, middleware guncelleme
- **Fark:** Hicbir DB IDE Prometheus endpoint sunmuyor
- **Karmasiklik:** Dusuk-Orta

### 9.15 IaC Connection Profile Export
- **Rol:** DevOps
- **Sorun:** Connection bilgileri localStorage'da, versiyon kontrol edilemiyor, yeni takim uyesine aktarilamiyor
- **Cozum:** Export formatlari: JSON, .env, Docker Compose, Terraform HCL, Kubernetes Secret YAML. Import: format auto-detect + onizleme. Client-side AES-GCM sifreleme (Web Crypto API). Paylasilabilir sifrelenmis link
- **Dosyalar:** Yeni `ConnectionExportModal.tsx`, `ConnectionImportModal.tsx`, `src/lib/connection-serializers.ts`
- **Karmasiklik:** Dusuk-Orta

### --- AI ENGINEER ---

### 9.16 Vector Data Explorer + Embedding Visualization
- **Rol:** AI/ML Engineer
- **Sorun:** pgvector/MongoDB Atlas Vector Search'teki embedding verileri opak byte array olarak gorunur. Kumeleme, benzerlik, dagilim gorunmuyor
- **Cozum:** Vector kolon tespiti (pgvector `vector(N)` tipi). PCA ile 2D'ye indirgeme + scatter plot. Renk kodlu metadata (kategoriye gore). "Find Similar" paneli: metin gir -> embedding uret -> similarity search. Mini sparkline cell renderer
- **Mevcut Altyapi:** Recharts scatter plot, provider metadata genisletilebilir
- **Dosyalar:** Yeni `VectorExplorer.tsx`, `VectorCell.tsx`, `VectorSimilaritySearch.tsx`, `src/lib/vector-utils.ts`, provider'lara `supportsVectors` capability
- **Fark:** HICBIR DB IDE vektorleri gorsellestirir. Pinecone/Weaviate consolelari vendor-specific
- **Karmasiklik:** Yuksek

### 9.17 RAG Pipeline Builder
- **Rol:** AI Engineer
- **Sorun:** RAG pipeline'i olusturmak icin DB IDE, Python script, vector store UI arasinda gidip gelmek gerekiyor
- **Cozum:** Gorsel pipeline builder: Source Query -> Chunking -> Embedding -> Target Table. Preview (5 satir ornegi). Batch processing + progress. Incremental mod (son islenen ID'den devam). LLM provider'lara `embed()` metodu eklenir
- **Dosyalar:** Yeni `RAGPipelineBuilder.tsx`, route `/api/ai/rag-pipeline`, `src/lib/rag/chunking.ts`, LLM provider'lara embedding desteği
- **Fark:** Hicbir DB IDE RAG pipeline builder sunmuyor
- **Karmasiklik:** Yuksek

### 9.18 Conversational Data Explorer (AI Agent)
- **Rol:** AI Engineer, DBA, Analyst
- **Sorun:** Mevcut AI chat tek turlu. Karmasik veri kesfinde ("churn eden kullanicilar -> son 5 siparisleri -> kategoriye gore avg") her adimda context kaybolur
- **Cozum:** Sorgu sonuclarini AI konusmasina enjekte eden conversational agent. AI sorgu uretir -> otomatik calistirir -> sonuclari gosterir -> kullanici devam sorgular. "Pin" ile onemli sonuclari context'te tut. "Fork" ile alternatif yollar kesfet. Notebook/Markdown olarak export
- **Dosyalar:** Yeni `ConversationalExplorer.tsx`, route `/api/ai/explore`, `src/lib/ai/conversation-context.ts`
- **Fark:** ChatGPT DB baglanmaz, DataGrip AI sonuc gormez. Bu ikisini birlestiren ilk arac
- **Karmasiklik:** Orta-Yuksek

### 9.19 Training Data Preparation Workbench
- **Rol:** ML Engineer
- **Sorun:** Fine-tuning/evaluation icin veri hazirlama (extraction, cleaning, labeling, format donusumleri) dagınik araclarla yapiliyor
- **Cozum:** Tek arayuzde: Extract (SQL) -> Clean (AI oneri) -> Label (AI siniflandirma + insan review) -> Validate (class balance, data leakage) -> Export (JSONL ChatML, CSV stratified split, HuggingFace format)
- **Dosyalar:** Yeni `TrainingDataWorkbench.tsx`, route `/api/ai/label-data`, `src/lib/training-data/` (formats, validators)
- **Fark:** Hicbir DB IDE ML data preparation yapmiyor
- **Karmasiklik:** Yuksek

---

## MEVCUT BACKLOG'LARLA ENTEGRASYON

Zaten planlanan 7 backlog ozelligi bu roadmap ile nasil entegre olur:

| Backlog | En Uygun Phase | Neden |
|---------|---------------|-------|
| 000-Platform Data Sync (PGlite) | Phase 1.2 alternatifi | Server-side persistence ile birlikte degerlendirilmeli |
| 001-Inline Data Editing | Phase 0.7'den sonra | Transaction control gerektirir |
| 002-Data Import | Phase 4'te | Multi-statement ve permission kontrolleri ile birlikte |
| 003-Query Time Machine | Phase 1.2'den sonra | Server-side storage gerektirir |
| 004-AI Data Storyteller | Phase 3.1'den sonra | Multi-turn AI ile daha guclu olur |
| 005-Query Playground | Phase 0.7 ile birlikte | Transaction control aynı altyapiyi kullanir |
| 006-Data Masking | Phase 1.3 ile birlikte | RBAC ile entegre olmali |

---

## ONERILEN UYGULAMA SIRASI (Rol-Bazli Ozelliklerle Guncellenmiş)

### Sprint 1: Quick Wins + DX (Hafta 1-2)
> Bagimliligi yok, hemen deger uretir

1. **0.1** Connection Testing (gercek) - `ConnectionModal.tsx`
2. **0.2** Connection Editing - `ConnectionModal.tsx`, `Sidebar.tsx`
3. **0.3** Connection String Import - yeni `connection-string-parser.ts`
4. **5.1** Command Palette (Cmd+K) - `cmdk` zaten yuklu
5. **5.6** Connection Groups / Color Coding - `Sidebar.tsx`, `types.ts`
6. **5.7** Tab Renaming - `Studio.tsx`
7. **5.5** SQL Export (INSERT, DDL) - `Studio.tsx` export func
8. **9.6** AI Query Explainer - `VisualExplain.tsx`'e AI tab (dusuk efor, yuksek deger)

### Sprint 2: Connectivity & Safety (Hafta 3-4)
> Tum rakiplerin sahip oldugu temel ozellikler

9. **0.4** SSL/TLS Configuration UI
10. **0.5** SSH Tunnel Destegi
11. **0.6** Query Cancellation / Abort
12. **0.7** Transaction Control (BEGIN/COMMIT/ROLLBACK)
13. **4.5** Multi-Statement Execution
14. **8.1** Redis Provider

### Sprint 3: Mevcut Backlog'lar - Oncelikli (Hafta 5-7)
> Kullanicinin istegi: mevcut backloglar oncelikli

15. **Backlog 005** Query Playground (Sandbox) - Transaction altyapisi hazir
16. **Backlog 006** Data Masking - RBAC gecici olarak mevcut admin/user ile
17. **Backlog 001** Inline Data Editing - Transaction + sandbox ile birlikte
18. **Backlog 002** Data Import (CSV, JSON, Excel) - schema bilgisi mevcut

### Sprint 4: AI Intelligence - Farklilasma (Hafta 8-10)
> Hicbir rakibin yapmadigi, LibreDB'yi one cikaracak

19. **3.1** Multi-Turn Conversational AI
20. **3.5** AI Query Safety Analysis (Pre-Execution)
21. **3.2** AI Index Advisor
22. **3.4** NL2SQL (Natural Language to Query)
23. **9.10** AI Query Performance Autopilot (DBA icin)
24. **9.7** Schema Change Impact Analyzer

### Sprint 5: Analyst & Developer Tools (Hafta 11-13)
> Her gun kullanan gelistirici ve analist icin

25. **9.1** AI Data Profiler (analyst)
26. **9.4** ORM Code Generator (developer)
27. **9.5** Test Data Generator / Faker (developer)
28. **9.2** Interactive Pivot Table (analyst)
29. **5.4** Data Filtering / WHERE Builder
30. **5.3** Database Documentation Generator

### Sprint 6: DBA & Monitoring (Hafta 14-16)
> Veritabani yoneticileri icin production-grade araclar

31. **9.11** Lock Dependency Graph (canli)
32. **9.12** Smart Vacuum Scheduler + Bloat Forecasting
33. **6.2** Connection Health Monitor (Background)
34. **6.1** Alerting ve Threshold Rules
35. **9.14** Prometheus Metrics Export (DevOps)

### Sprint 7: Enterprise Foundation (Hafta 17-20)
> Kurumsal kullanim icin zorunlu altyapi

36. **1.1** User Identity ve Team Management
37. **1.2** Server-Side State Persistence
38. **1.3** Connection-Level Access Control
39. **1.4** Audit Log
40. **Backlog 003** Query Time Machine (persistence hazir)
41. **Backlog 004** AI Data Storyteller (multi-turn AI hazir)

### Sprint 8: Collaboration (Hafta 21-24)
> Web avantajini kullanan paylasim ozellikleri

42. **2.1** Shared Query Workspaces
43. **2.2** Query Review & Approval Workflow
44. **2.3** Notifications ve Activity Feed
45. **9.3** Smart Query Notebook (Jupyter-benzeri)

### Sprint 9: Data Engineering & AI Engineering (Hafta 25-28)
> Uzman roller icin ileri seviye ozellikler

46. **9.8** Cross-Database Query Federation
47. **9.9** Data Quality Rules Engine
48. **9.16** Vector Data Explorer + Embedding Visualization
49. **9.18** Conversational Data Explorer (AI Agent)
50. **9.13** Multi-Environment Schema Diff + AI Migration

### Sprint 10: Advanced & Integration (Hafta 29-32)
> Platform olgunlugu ve genisletilebilirlik

51. **9.17** RAG Pipeline Builder
52. **9.19** Training Data Workbench
53. **9.15** IaC Connection Export
54. **7.1** REST API (Public)
55. **7.2** Plugin System
56. **7.3** Git Integration
57. **8.2** ClickHouse Provider
58. **8.3** DynamoDB Provider
59. **Backlog 000** Platform Data Sync (PGlite + ElectricSQL)

---

## BAGIMLILIK GRAFI

```
BAGIMSIZ (hemen baslanabilir):
├── Phase 0 (Kritik Eksikler)
├── 5.1 Command Palette
├── 5.5 SQL Export
├── 5.6 Connection Groups
├── 5.7 Tab Renaming
├── 9.6 AI Query Explainer
├── 8.1 Redis Provider
├── 9.4 ORM Code Generator
├── 9.14 Prometheus Metrics Export
└── 9.15 IaC Connection Export

Phase 0.7 (Transaction) gerektiren:
├── Backlog 005 Query Playground
├── Backlog 001 Inline Data Editing
└── 9.5 Test Data Generator

Mevcut LLM altyapisi gerektiren (bagimsiz):
├── 3.1 Multi-Turn AI
├── 3.2 AI Index Advisor
├── 3.4 NL2SQL
├── 3.5 AI Safety Analysis
├── 9.1 Data Profiler
├── 9.7 Impact Analyzer
└── 9.10 Query Autopilot

Phase 1 (Enterprise) -> Phase 2 (Collaboration):
Phase 1.1 (User) ─┐
                   ├─ 1.2 (Persistence) ─┐
                   │     │                ├─ 2.1 Shared Workspaces
                   │     ├─ 1.3 (RBAC)   ├─ 2.2 Query Review
                   │     ├─ 1.4 (Audit)  ├─ 2.3 Notifications
                   │     ├─ Backlog 003   ├─ 9.3 Notebook
                   │     └─ Backlog 004   └─ 6.1 Alerting
                   │
                   └─ Phase 7 (Integration) + Phase 4 (Operations)

Phase 9 Advanced (sonraki sprintler):
├── 9.8 Cross-DB Federation (2+ baglanti gerekir)
├── 9.16 Vector Explorer (schema desteği gerekir)
├── 9.17 RAG Pipeline (LLM embed() gerekir)
├── 9.19 Training Workbench (LLM labeling gerekir)
└── 9.13 Schema Diff (2 baglanti + AI migration)
```

---

## OZET: TOPLAM OZELLIK SAYILARI (Rol Bazli)

| Rol | Ozellik Sayisi | Onemli Ozellikler |
|-----|---------------|-------------------|
| **Tum Roller** | 12 | Connection testing/editing/SSH/SSL, Command Palette, Transaction, Query Cancel |
| **SQL Data Analyst** | 4 | Data Profiler, Pivot Table, Notebook, AI Query Explainer |
| **Developer** | 5 | ORM CodeGen, Test Data Faker, Impact Analyzer, Query Diff, SQL Export |
| **Data Engineer** | 3 | Cross-DB Federation, Data Quality Rules, Schema Diff |
| **DBA** | 5 | Query Autopilot, Lock Graph, Vacuum Scheduler, Index Advisor, Alerting |
| **DevOps** | 3 | Prometheus Export, IaC Export, Background Health |
| **AI Engineer** | 4 | Vector Explorer, RAG Pipeline, Conv. Explorer, Training Workbench |
| **Enterprise/Collab** | 7 | User Identity, RBAC, Audit, Workspaces, Review, Notifications, Notebook |
| **New DB Support** | 3 | Redis, ClickHouse, DynamoDB |
| **Mevcut Backlog** | 7 | PGlite Sync, Inline Edit, Data Import, Time Machine, AI Storyteller, Sandbox, Masking |

**Toplam: ~59 ozellik, 10 sprint, ~32 hafta**

---

## KRITIK DOSYALAR

Tum phase'larda en cok degisecek dosyalar:

| Dosya | Neden Kritik |
|-------|-------------|
| `src/components/Studio.tsx` | Ana shell - tum yeni panel modlari, toolbar butonlari, modal'lar buraya entegre olur |
| `src/lib/db/types.ts` | Tum yeni interface'ler (profile, lock, vector, quality) burada tanimlanir |
| `src/lib/db/base-provider.ts` | Yeni provider metodlari (profileTable, getLockDeps, vectorSearch) abstract olarak eklenir |
| `src/lib/types.ts` | DatabaseConnection genisletme (SSH, SSL, color, group alanlari) |
| `src/app/api/ai/chat/route.ts` | Tum AI ozellikleri icin temel - system prompt builder genisletilir |
| `src/app/api/db/query/route.ts` | Query cancellation, transaction control, audit logging enforcement point |
| `src/lib/storage.ts` | Notebooks, data quality rules, query versioning icin genisletme |
| `src/components/ConnectionModal.tsx` | SSH, SSL, edit mode, connection string, test connection |
| `src/components/QueryEditor.tsx` | AI conversation UI, snippet entegrasyonu |
| `src/components/ResultsGrid.tsx` | Data filtering, inline editing, vector cell, masking |

---

## DOGRULAMA VE TEST

Her sprint sonunda:
1. `bun run build` - Production build basarili olmali
2. `bun run lint` - Lint hatasiz olmali
3. Manuel test: Tum mevcut ozellikler kirilmamis olmali (regression)
4. Yeni ozellik icin end-to-end test: Browser'da gercek senaryo
5. Demo modunda yeni ozelligin calismasi kontrol edilmeli
6. Mobile responsive kontrol (768px breakpoint)
7. Provider-agnostic test: Ozelligin en az 2 farkli DB tipinde calismasi dogrulanmali
