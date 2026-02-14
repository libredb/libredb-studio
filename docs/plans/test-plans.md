# LibreDB Studio — Kapsamlı Test Altyapısı Planı

## Bağlam

LibreDB Studio enterprise-grade, open-source bir SQL IDE'dir. ~146 kaynak dosya, ~36,000+ satır kod var ve test altyapısı neredeyse sıfır (tek bir `postgres.test.ts` dosyası `bun:test` kullanıyor). Yeni katılımcıların güvenle geliştirme yapabilmesi ve production-ready kaliteyi korumak için kapsamlı bir test altyapısı şart.

**Hedef:** Unit test, integration test, API test, UI component test ve E2E test ile %100 code coverage.

---

## Faz 0: Altyapı Kurulumu

### 0.1 — Bağımlılıkları Yükle

```bash
bun add -d @testing-library/react @testing-library/jest-dom @testing-library/user-event happy-dom @playwright/test
```

### 0.2 — `bunfig.toml` Oluştur (Yeni dosya)

```toml
[test]
preload = ["./tests/setup.ts"]

[test.coverage]
enabled = true
reporter = ["lcov", "text"]
```

### 0.3 — `tests/setup.ts` Oluştur (Yeni dosya)

- `process.env.JWT_SECRET`, `ADMIN_PASSWORD`, `USER_PASSWORD` test değerleri
- `globalThis.localStorage` in-memory mock (SSR ortamı için)
- `afterEach` → `localStorage.clear()` cleanup

### 0.4 — Test Fixture'ları Oluştur

| Dosya | İçerik |
|-------|--------|
| `tests/fixtures/connections.ts` | Her DB tipi için mock `DatabaseConnection` objeleri (postgres, mysql, sqlite, mongodb, redis, oracle, mssql, demo) |
| `tests/fixtures/schemas.ts` | Mock `TableSchema[]` objeleri |
| `tests/fixtures/query-results.ts` | Mock `QueryResult` objeleri |
| `tests/fixtures/masking-configs.ts` | Mock `MaskingConfig` objeleri |

### 0.5 — Test Helper'ları Oluştur

| Dosya | İçerik |
|-------|--------|
| `tests/helpers/mock-provider.ts` | `createMockProvider()` — tüm `DatabaseProvider` metodlarını mock'layan factory |
| `tests/helpers/mock-next.ts` | `createMockRequest()`, `createMockCookies()` — Next.js API test helper'ları |
| `tests/helpers/mock-fetch.ts` | Global `fetch` mock helper |
| `tests/helpers/mock-monaco.ts` | Monaco Editor'ü `<textarea>` olarak mock'la |
| `tests/helpers/render-with-providers.tsx` | Component test wrapper (theme, toast, router provider) |

### 0.6 — `package.json` Script'leri Ekle

```json
{
  "test": "bun test",
  "test:unit": "bun test tests/unit",
  "test:integration": "bun test tests/integration",
  "test:hooks": "bun test tests/hooks",
  "test:api": "bun test tests/api",
  "test:components": "bun test tests/components",
  "test:e2e": "bunx playwright test",
  "test:coverage": "bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage"
}
```

### 0.7 — `playwright.config.ts` Oluştur (Yeni dosya)

- `testDir: './e2e'`, `baseURL: 'http://localhost:3000'`
- Chromium projesi, `webServer` → `bun run build && bun start`
- CI'da `retries: 2`, `workers: 1`

### 0.8 — Mevcut `postgres.test.ts` Taşı

- `src/lib/db/providers/sql/postgres.test.ts` → `tests/integration/db/postgres-provider.test.ts`

---

## Faz 1: Unit Testler — Saf Fonksiyonlar

**En yüksek ROI:** Saf fonksiyonlar, sıfır mocking, en kritik iş mantığı.

| # | Test Dosyası | Kaynak | Test Sayısı | Açıklama |
|---|---|---|---|---|
| 1 | `tests/unit/sql/statement-splitter.test.ts` | `src/lib/sql/statement-splitter.ts` | ~40 | Tek/çoklu statement, string literal `''`, `"identifiers"`, `--` ve `/* */` yorumlar, `$$dollar-quote$$`, unterminated string, boş input, `isMultiStatement()` |
| 2 | `tests/unit/lib/connection-string-parser.test.ts` | `src/lib/connection-string-parser.ts` | ~45 | `postgres://`, `mysql://`, `mongodb://`, `mongodb+srv://`, `redis://`, `oracle://`, `mssql://`, `sqlserver://`, ADO.NET `Server=`, URL encoding, özel karakter, eksik parça, `detectConnectionStringType()` |
| 3 | `tests/unit/lib/data-masking.test.ts` | `src/lib/data-masking.ts` | ~60 | 10 mask tipi (email, phone, card, ssn, full, partial, ip, date, financial, custom), `maskByType()`, `detectSensitiveColumnsFromConfig()`, `shouldMask()` RBAC, `canToggleMasking()`, `canReveal()`, `applyMaskingToRows()`, null/undefined edge case'ler |
| 4 | `tests/unit/db/query-limiter.test.ts` | `src/lib/db/utils/query-limiter.ts` | ~50 | `analyzeQuery()` SELECT/INSERT/UPDATE/DELETE/DDL, LIMIT/OFFSET tespiti, MySQL `LIMIT x,y`, Oracle `FETCH FIRST`, MSSQL `TOP N`, `ROWNUM`, UNION, CTE, subquery. `applyQueryLimit()` mevcut LIMIT ile/olmadan, `forceLimit` |
| 5 | `tests/unit/db/errors.test.ts` | `src/lib/db/errors.ts` | ~35 | 6 error class constructor + `toJSON()`, 5 type guard, `isRetryableError()`, `mapDatabaseError()` — connection/auth/timeout/query/pool pattern matching, Oracle ORA-*, MSSQL pattern'ler |
| 6 | `tests/unit/sql/alias-extractor.test.ts` | `src/lib/sql/alias-extractor.ts` | ~30 | FROM/JOIN alias'ları, CTE alias, schema.table, `resolveAlias()`, `getAliasSchema()`, comment/string içindeki SQL, boş query |
| 7 | `tests/unit/schema-diff/diff-engine.test.ts` | `src/lib/schema-diff/diff-engine.ts` | ~25 | Eklenen/silinen/değiştirilen tablolar ve kolonlar, index diff, FK diff, aynı schema (no-change), boş schema |
| 8 | `tests/unit/schema-diff/migration-generator.test.ts` | `src/lib/schema-diff/migration-generator.ts` | ~20 | CREATE/DROP/ALTER TABLE her dialect için (PG, MySQL, SQLite, Oracle, MSSQL), identifier escaping |
| 9 | `tests/unit/lib/query-generators.test.ts` | `src/lib/query-generators.ts` | ~12 | `generateTableQuery()` SQL/JSON/Oracle/MSSQL, `generateSelectQuery()` her dialect, `shouldRefreshSchema()` DDL pattern'ler |
| 10 | `tests/unit/lib/storage.test.ts` | `src/lib/storage.ts` | ~20 | CRUD: connections, history (max limit), saved queries, schema snapshots (max 50), charts, active connection ID. Bozuk JSON error handling |
| 11 | `tests/unit/lib/time-series-buffer.test.ts` | `src/lib/time-series-buffer.ts` | ~15 | push, getAll, getRange, getLast, clear, circular overflow, size |
| 12 | `tests/unit/lib/audit.test.ts` | `src/lib/audit.ts` | ~15 | RingBuffer push/getAll/getRecent/filter/clear/size/toJSON/loadFrom, max size |
| 13 | `tests/unit/lib/monitoring-thresholds.test.ts` | `src/lib/monitoring-thresholds.ts` | ~12 | `evaluateThreshold()` above/below yönleri, healthy/warning/critical, `getThresholdColor()`, `getThresholdBadgeVariant()` |
| 14 | `tests/unit/db/pool-manager.test.ts` | `src/lib/db/utils/pool-manager.ts` | ~20 | `mergePoolConfig()`, `validatePoolConfig()`, `withTimeout()` success/timeout, `formatBytes()`, `formatDuration()`, `escapeIdentifier()` per dialect |
| 15 | `tests/unit/llm/config.test.ts` | `src/lib/llm/utils/config.ts` | ~20 | `resolveConfig()`, `validateConfig()` her provider için, `requiresApiKey()`, `requiresApiUrl()`, `getSafeConfigForLogging()` |
| 16 | `tests/unit/llm/retry.test.ts` | `src/lib/llm/utils/retry.ts` | ~10 | `withRetry()` ilk seferde başarı, retry + başarı, tüm retry tükenme, non-retryable error |
| 17 | `tests/unit/llm/streaming.test.ts` | `src/lib/llm/utils/streaming.ts` | ~10 | `encodeText()`/`decodeText()`, `createSSEParser()` OpenAI-format, `[DONE]`, malformed JSON, `createErrorStream()` |

**Faz 1 Toplam:** 17 test dosyası, ~409 test case, **~%30 coverage**

---

## Faz 2: API Route Testleri

Route handler'lar doğrudan import edilip mock `NextRequest` ile çağrılır. DB provider ve auth `mock.module()` ile mock'lanır.

**Mock Stratejisi:**
- `mock.module('@/lib/db')` → mock provider döndürür
- `mock.module('@/lib/auth')` → `getSession()` kontrol edilir
- Her HTTP metod, başarı/hata path'i, validasyon, status code test edilir

| # | Test Dosyası | Kaynak | Test Sayısı |
|---|---|---|---|
| 1 | `tests/api/auth/login.test.ts` | `src/app/api/auth/login/route.ts` | ~8 |
| 2 | `tests/api/auth/me.test.ts` | `src/app/api/auth/me/route.ts` | ~4 |
| 3 | `tests/api/auth/logout.test.ts` | `src/app/api/auth/logout/route.ts` | ~3 |
| 4 | `tests/api/db/query.test.ts` | `src/app/api/db/query/route.ts` | ~12 |
| 5 | `tests/api/db/multi-query.test.ts` | `src/app/api/db/multi-query/route.ts` | ~10 |
| 6 | `tests/api/db/schema.test.ts` | `src/app/api/db/schema/route.ts` | ~6 |
| 7 | `tests/api/db/health.test.ts` | `src/app/api/db/health/route.ts` | ~6 |
| 8 | `tests/api/db/test-connection.test.ts` | `src/app/api/db/test-connection/route.ts` | ~8 |
| 9 | `tests/api/db/transaction.test.ts` | `src/app/api/db/transaction/route.ts` | ~12 |
| 10 | `tests/api/db/cancel.test.ts` | `src/app/api/db/cancel/route.ts` | ~6 |
| 11 | `tests/api/db/maintenance.test.ts` | `src/app/api/db/maintenance/route.ts` | ~8 |
| 12 | `tests/api/db/monitoring.test.ts` | `src/app/api/db/monitoring/route.ts` | ~6 |
| 13 | `tests/api/db/provider-meta.test.ts` | `src/app/api/db/provider-meta/route.ts` | ~6 |
| 14 | `tests/api/db/pool-stats.test.ts` | `src/app/api/db/pool-stats/route.ts` | ~4 |
| 15 | `tests/api/db/profile.test.ts` | `src/app/api/db/profile/route.ts` | ~8 |
| 16 | `tests/api/db/schema-snapshot.test.ts` | `src/app/api/db/schema-snapshot/route.ts` | ~6 |
| 17 | `tests/api/ai/chat.test.ts` | `src/app/api/ai/chat/route.ts` | ~10 |
| 18 | `tests/api/ai/nl2sql.test.ts` | `src/app/api/ai/nl2sql/route.ts` | ~8 |
| 19 | `tests/api/ai/explain.test.ts` | `src/app/api/ai/explain/route.ts` | ~8 |
| 20 | `tests/api/ai/query-safety.test.ts` | `src/app/api/ai/query-safety/route.ts` | ~8 |
| 21 | `tests/api/ai/autopilot.test.ts` | `src/app/api/ai/autopilot/route.ts` | ~6 |
| 22 | `tests/api/ai/index-advisor.test.ts` | `src/app/api/ai/index-advisor/route.ts` | ~6 |
| 23 | `tests/api/ai/impact.test.ts` | `src/app/api/ai/impact/route.ts` | ~6 |
| 24 | `tests/api/ai/describe-schema.test.ts` | `src/app/api/ai/describe-schema/route.ts` | ~4 |
| 25 | `tests/api/admin/fleet-health.test.ts` | `src/app/api/admin/fleet-health/route.ts` | ~6 |
| 26 | `tests/api/admin/audit.test.ts` | `src/app/api/admin/audit/route.ts` | ~6 |
| 27 | `tests/api/middleware.test.ts` | `src/middleware.ts` | ~15 |

**Faz 2 Toplam:** 27 test dosyası, ~199 test case, **kümülatif ~%55 coverage**

---

## Faz 3: Provider Integration Testleri

Her provider'ın native DB client'ı `mock.module()` ile mock'lanır. Mevcut `postgres.test.ts` pattern'i takip edilir.

**Test edilen metodlar:** `connect()`, `disconnect()`, `query()`, `getSchema()`, `getHealth()`, `runMaintenance()`, `prepareQuery()`, `getCapabilities()`, `getLabels()`, error mapping.

| # | Test Dosyası | Mock Target | Test Sayısı |
|---|---|---|---|
| 1 | `tests/integration/db/demo-provider.test.ts` | Yok (in-memory) | ~15 |
| 2 | `tests/integration/db/postgres-provider.test.ts` | `pg.Pool` | ~20 |
| 3 | `tests/integration/db/mysql-provider.test.ts` | `mysql2/promise` | ~18 |
| 4 | `tests/integration/db/sqlite-provider.test.ts` | `better-sqlite3` | ~15 |
| 5 | `tests/integration/db/mongodb-provider.test.ts` | `mongodb.MongoClient` | ~18 |
| 6 | `tests/integration/db/redis-provider.test.ts` | `ioredis` | ~15 |
| 7 | `tests/integration/db/oracle-provider.test.ts` | `oracledb` | ~18 |
| 8 | `tests/integration/db/mssql-provider.test.ts` | `mssql` | ~18 |
| 9 | `tests/unit/db/factory.test.ts` | Dynamic imports + SSH | ~15 |
| 10 | `tests/unit/db/base-provider.test.ts` | Abstract class mock impl | ~12 |

**Faz 3 Toplam:** 10 test dosyası, ~164 test case, **kümülatif ~%70 coverage**

---

## Faz 4: React Hook Testleri

`@testing-library/react` `renderHook` + `act` kullanılır. `fetch` global mock'lanır.

| # | Test Dosyası | Kaynak | Test Sayısı |
|---|---|---|---|
| 1 | `tests/hooks/use-auth.test.ts` | `src/hooks/use-auth.ts` | ~8 |
| 2 | `tests/hooks/use-connection-manager.test.ts` | `src/hooks/use-connection-manager.ts` | ~15 |
| 3 | `tests/hooks/use-tab-manager.test.ts` | `src/hooks/use-tab-manager.ts` | ~12 |
| 4 | `tests/hooks/use-query-execution.test.ts` | `src/hooks/use-query-execution.ts` | ~20 |
| 5 | `tests/hooks/use-transaction-control.test.ts` | `src/hooks/use-transaction-control.ts` | ~8 |
| 6 | `tests/hooks/use-inline-editing.test.ts` | `src/hooks/use-inline-editing.ts` | ~10 |
| 7 | `tests/hooks/use-connection-form.test.ts` | `src/hooks/use-connection-form.ts` | ~15 |
| 8 | `tests/hooks/use-provider-metadata.test.ts` | `src/hooks/use-provider-metadata.ts` | ~8 |
| 9 | `tests/hooks/use-monitoring-data.test.ts` | `src/hooks/use-monitoring-data.ts` | ~12 |
| 10 | `tests/hooks/use-ai-chat.test.ts` | `src/hooks/use-ai-chat.ts` | ~10 |
| 11 | `tests/hooks/use-mobile.test.ts` | `src/hooks/use-mobile.ts` | ~4 |
| 12 | `tests/hooks/use-toast.test.ts` | `src/hooks/use-toast.ts` | ~4 |

**Faz 4 Toplam:** 12 test dosyası, ~126 test case, **kümülatif ~%80 coverage**

---

## Faz 5: Component Testleri

`happy-dom` ortamı, `@testing-library/react`, Monaco/Recharts/ReactFlow mock'ları.

**Heavy Dependency Mock'ları:**
- `@monaco-editor/react` → `<textarea data-testid="mock-monaco-editor">`
- `recharts` → basit `<div>` wrapper'ları
- `@xyflow/react` → `<div>` wrapper
- `framer-motion` → children pass-through (animasyonsuz)

| # | Test Dosyası | Kaynak | Test Sayısı |
|---|---|---|---|
| 1 | `tests/components/ConnectionModal.test.tsx` | `src/components/ConnectionModal.tsx` | ~15 |
| 2 | `tests/components/ResultsGrid.test.tsx` | `src/components/ResultsGrid.tsx` | ~12 |
| 3 | `tests/components/Studio.test.tsx` | `src/components/Studio.tsx` | ~10 |
| 4 | `tests/components/CommandPalette.test.tsx` | `src/components/CommandPalette.tsx` | ~8 |
| 5 | `tests/components/QueryEditor.test.tsx` | `src/components/QueryEditor.tsx` | ~8 |
| 6 | `tests/components/sidebar/Sidebar.test.tsx` | `src/components/sidebar/Sidebar.tsx` | ~8 |
| 7 | `tests/components/sidebar/ConnectionItem.test.tsx` | `src/components/sidebar/ConnectionItem.tsx` | ~6 |
| 8 | `tests/components/sidebar/ConnectionsList.test.tsx` | `src/components/sidebar/ConnectionsList.tsx` | ~6 |
| 9 | `tests/components/QueryHistory.test.tsx` | `src/components/QueryHistory.tsx` | ~8 |
| 10 | `tests/components/DataCharts.test.tsx` | `src/components/DataCharts.tsx` | ~10 |
| 11 | `tests/components/SchemaDiagram.test.tsx` | `src/components/SchemaDiagram.tsx` | ~8 |
| 12 | `tests/components/SchemaDiff.test.tsx` | `src/components/SchemaDiff.tsx` | ~8 |
| 13 | `tests/components/MaskingSettings.test.tsx` | `src/components/MaskingSettings.tsx` | ~8 |
| 14 | `tests/components/DataProfiler.test.tsx` | `src/components/DataProfiler.tsx` | ~6 |
| 15 | `tests/components/schema-explorer/SchemaExplorer.test.tsx` | `src/components/SchemaExplorer/` | ~6 |
| 16 | `tests/components/admin/AdminDashboard.test.tsx` | `src/components/admin/AdminDashboard.tsx` | ~8 |
| 17 | `tests/components/admin/OverviewTab.test.tsx` | `src/components/admin/tabs/OverviewTab.tsx` | ~8 |
| 18 | `tests/components/admin/OperationsTab.test.tsx` | `src/components/admin/tabs/OperationsTab.tsx` | ~6 |
| 19 | `tests/components/admin/SecurityTab.test.tsx` | `src/components/admin/tabs/SecurityTab.tsx` | ~6 |
| 20 | `tests/components/admin/AuditTab.test.tsx` | `src/components/admin/tabs/AuditTab.tsx` | ~6 |
| 21 | `tests/components/monitoring/MonitoringDashboard.test.tsx` | `src/components/monitoring/MonitoringDashboard.tsx` | ~8 |
| 22 | `tests/components/studio/BottomPanel.test.tsx` | `src/components/studio/BottomPanel.tsx` | ~6 |
| 23 | `tests/components/studio/QueryToolbar.test.tsx` | `src/components/studio/QueryToolbar.tsx` | ~6 |
| 24 | `tests/components/studio/StudioTabBar.test.tsx` | `src/components/studio/StudioTabBar.tsx` | ~6 |

**Faz 5 Toplam:** 24 test dosyası, ~187 test case, **kümülatif ~%92 coverage**

---

## Faz 6: E2E Testler (Playwright)

Tam tarayıcı testleri, çalışan Next.js server'a karşı.

| # | Test Dosyası | Senaryo |
|---|---|---|
| 1 | `e2e/login.spec.ts` | Admin/user login, yanlış şifre, redirect |
| 2 | `e2e/demo-mode.spec.ts` | Demo connection, örnek query, sonuçlar |
| 3 | `e2e/connection-management.spec.ts` | Connection ekle/düzenle/sil |
| 4 | `e2e/query-execution.spec.ts` | Query yaz, çalıştır, sonuç gör |
| 5 | `e2e/tab-management.spec.ts` | Tab ekle/kapat/yeniden adlandır/değiştir |
| 6 | `e2e/export.spec.ts` | CSV/JSON/SQL export |
| 7 | `e2e/admin-dashboard.spec.ts` | Admin erişim, tab'lar, fleet health |

**Faz 6 Toplam:** 7 test dosyası, ~40 test case, **kümülatif ~%95+ coverage**

---

## Faz 7: CI/CD Entegrasyonu

### `.github/workflows/ci.yml` Güncelleme

Mevcut `lint-and-build` job'una ek olarak:

**Yeni `test` job:**
```yaml
test:
  name: Unit & Integration Tests
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - run: bun install --frozen-lockfile
    - run: bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage
    - uses: actions/upload-artifact@v4 (coverage/lcov.info)
```

**Yeni `e2e` job:**
```yaml
e2e:
  name: E2E Tests
  needs: [lint-and-build]
  steps:
    - bunx playwright install --with-deps chromium
    - bunx playwright test
    - Upload playwright-report artifact
```

**`sonarcloud` job güncelleme:**
- `needs: [test]` ekle
- Coverage artifact'ını indir

### `sonar-project.properties` Güncelleme

```properties
sonar.test.inclusions=tests/**/*.test.ts,tests/**/*.test.tsx,e2e/**/*.spec.ts
sonar.exclusions=**/node_modules/**,**/.next/**,**/build/**,**/out/**,tests/**,e2e/**,src/components/ui/**
```

`src/components/ui/**` exclude → Shadcn/Radix primitives (3rd-party generated kod, test gerektirmez).

---

## Coverage Hedefleri Özet

| Faz | Kapsam | Dosya | Test Case | Kümülatif Coverage |
|-----|--------|-------|-----------|-------------------|
| 0 | Altyapı | 12 (setup) | 0 | %0 |
| 1 | Saf Fonksiyonlar | 17 | ~409 | ~%30 |
| 2 | API Routes | 27 | ~199 | ~%55 |
| 3 | DB Providers | 10 | ~164 | ~%70 |
| 4 | React Hooks | 12 | ~126 | ~%80 |
| 5 | Components | 24 | ~187 | ~%92 |
| 6 | E2E | 7 | ~40 | ~%95+ |
| 7 | CI/CD | 2 (config) | — | — |
| **Toplam** | | **~111** | **~1,125** | **%95-100** |

%100 hedefine ulaşmak için Faz 6 sonrası lcov raporundan kalan uncovered branch'ler tespit edilip ek edge-case testleri yazılır.

---

## Framework Seçim Gerekçesi

| Katman | Araç | Neden |
|--------|------|-------|
| Unit/Integration | `bun:test` | Zaten kullanılıyor, sıfır ek bağımlılık, native TS, Jest-uyumlu API, lcov desteği |
| Component/Hook | `@testing-library/react` + `happy-dom` | React standartı, `renderHook`, Bun ile ESM uyumlu |
| E2E | `@playwright/test` | Multi-browser, Next.js App Router desteği, HTML reporter |
| Coverage | `bun test --coverage` | Built-in lcov reporter → SonarCloud entegrasyonu |

---

## Doğrulama Planı

Her faz sonunda:
1. `bun test` — tüm testler geçmeli
2. `bun test --coverage` — coverage oranı kontrol edilmeli
3. `bun run lint` — test dosyaları lint'ten geçmeli
4. `bun run typecheck` — type hatası olmamalı
5. CI pipeline'da (`bun test` + `bunx playwright test`) başarıyla çalışmalı
