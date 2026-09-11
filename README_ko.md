<p align="center">
  <img src="public/logo.svg" width="200" alt="LibreDB Studio Logo" />
</p>

<h1 align="center">LibreDB Studio</h1>

<p align="center">
  <strong>노트북 위에 설치하는 데이터베이스 편집기가 아니라, 데이터 옆에 배포하는 데이터베이스 편집기.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README_zh.md">简体中文</a> ·
  <a href="README_ja.md">日本語</a> ·
  <a href="README_es.md">Español</a> ·
  <a href="README_ur.md">اردو</a> ·
  <b>한국어</b>
</p>

<p align="center">
  PostgreSQL 프로젝트에 등재:
  <a href="https://www.postgresql.org/about/news/libredb-studio-an-open-source-self-hosted-sql-ide-for-postgresql-in-the-browser-3368/">News</a>
  ·
  <a href="https://www.postgresql.org/download/products/1/">Software Catalogue</a>
  ·
  <a href="https://wiki.postgresql.org/wiki/Community_Guide_to_PostgreSQL_GUI_Tools#LibreDB_Studio">Community Guide to GUI Tools</a>
</p>
<p align="center">
  <a href="https://redis.io/docs/latest/develop/tools/#libredb-studio">Redis</a>,
  <a href="https://clickhouse.com/docs/integrations/connectors/tools/gui#libredb-studio">ClickHouse</a>,
  <a href="https://mariadb.com/docs/server/clients-and-utilities/graphical-and-enhanced-clients/libredb-studio">MariaDB</a>,
  <a href="https://trino.io/ecosystem/client-application#libredb-studio">Trino</a>,
  <a href="https://cloudberry.apache.org/docs/ecosystem/sql-clients/libredb-studio/">Apache Cloudberry</a>
  공식 문서에도 등재
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

## 퀵 스타트

클론도 빌드도 필요 없습니다. 명령어 한 번으로 풀 기능 SQL IDE가 뜹니다.

```bash
# Docker (권장)
docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest

# 또는 Node.js 24+ 환경에서 (Docker 없이)
npx @libredb/studio
```

**http://localhost:3000** 을 열면 끝입니다. 첫 실행 시 관리자 비밀번호가 로그에 출력되므로 설정 파일이 필요 없습니다.

> localhost가 아닌 HTTPS가 아닌 경로(예: LAN 안의 `http://192.168.x.x:3000`)로 접속한다면 `AUTH_COOKIE_SECURE=false`를 설정하세요. 그렇지 않으면 헬스체크는 정상인데 로그인만 조용히 실패하며 로그인 화면으로 계속 되돌아갑니다.

Helm, Homebrew, Snap, winget, deb/rpm은 [설치 방법](#설치-방법)을 참고하세요.

## 왜 또 다른 데이터베이스 도구를 만들었나

관리형 서비스에서 Postgres를 만들면 40초 만에 사용할 수 있게 됩니다.

그런데 내용을 들여다보려면 포트를 인터넷에 열거나, 데스크톱 클라이언트를 설치하고 SSH 터널을 파거나, 그냥 포기하고 셸을 쳐야 합니다. 데이터베이스까지는 40초. 거기에 창 하나 여는 데 반나절이 사라집니다.

여기서 곱셈이 됩니다. 앱은 Postgres, 문서는 Mongo, 캐시는 Redis, 이벤트는 ClickHouse. 데이터베이스 4개, 클라이언트 4개, 자격 증명 4조. 월요일에 새 동료가 들어오면 첫 줄을 쓰기 전에 어디에 어떤 데이터가 있는지 찾고, 접속 문자열을 위키와 DM 세 개에서 긁어모으고, VPN 권한을 기다리고, 엔진마다 다른 도구를 설치하게 됩니다.

**데이터베이스는 이미 이동했습니다.** Kubernetes 안으로, 관리형 클라우드 너머로, 점프 서버를 통해 도달하는 고객의 VPC로. **그러나 그것을 읽는 도구는 이동하지 않았습니다.** 여전히 무거운 데스크톱 앱이고, 좌석 과금이고, 설치가 전제이고, "데이터베이스는 하나, PC는 한 대, 담당자는 기기를 바꾸지 않는다"는 가정 위에 서 있습니다.

LibreDB Studio는 반대입니다. **데이터를 도구 앞으로 가져오는 것이 아니라, 도구가 데이터 앞으로 갑니다.**

이 전제를 진지하게 받아들리면, 취향의 문제가 아니라 명세가 됩니다.

- 데이터도 동료도 내 컴퓨터 위에 없으니, 편집기는 브라우저에서 돌아가야 합니다.
- 쿼리가 필요한 장애는 내가 노트북을 열 때까지 기다려주지 않으니, 스마트폰에도 닿아야 합니다.
- 데이터베이스 옆에 놓이는 것은 모두 그 방식으로 들어오니, 컨테이너, Helm 차트, Operator, 원클릭 템플릿의 형태로 배포될 수 있어야 합니다.
- 편집기가 가장 쓸모 있는 곳은 그 데이터베이스를 만든 제품 안이므로, 임베드 가능해야 합니다.
- 좌석 과금에 기능이 계단식인 도구를 가진 모든 환경에 둘 수는 없으니, 아끼는 것이 있어서는 안 됩니다. **싱글 사인이 유료가 되는 순간, 그 도구는 "기본으로 배포할 수 있는 도구"가 아닙니다.**

> MIT는 관대함이 아니라 이 아키텍처의 요구사항입니다.

## 주요 기능

### 16개 엔진, 하나의 인터페이스

PostgreSQL · MySQL · Oracle · SQL Server · SQLite · libSQL · DuckDB · MongoDB · Redis · Couchbase · ClickHouse · Apache Druid · Elasticsearch · OpenSearch · Apache Trino · Apache Cassandra

스키마 탐색기, ER 다이어그램, 스키마 diff, 모니터링은 모든 SQL 엔진에서 공통입니다. MongoDB와 Redis는 SQL 엔진이 아니라 ER 다이어그램과 스키마 diff가 없습니다. Druid, Elasticsearch, OpenSearch, Trino는 이 빌드가 파싱할 수 있는 URI 형식이 없는 만큼 호스트와 포트로 설정하는 이중 예외이며, 생성되는 마이그레이션도 DDL을 내뱉지 않고 제약을 명시합니다(Couchbase의 스키마리스 컬렉션도 마찬가지). 검색 클러스터의 ER 다이어그램은 상자만 있고 간선은 없습니다. 인덱스는 외래 키를 선언하지 않고 엔진의 모델에도 선언할 외래 키가 없기 때문입니다.

| 데이터베이스 | 드라이버 | 기능 |
| :--- | :--- | :--- |
| **PostgreSQL** | `pg` | 풀 SQL IDE, EXPLAIN 실행 계획, 트랜잭션, 쿼리 취소(`pg_cancel_backend`) |
| **MySQL** | `mysql2` | 풀 SQL IDE, EXPLAIN 실행 계획, 트랜잭션, 쿼리 취소(`KILL QUERY`) |
| **Oracle** | `oracledb`(Thin 모드) | 풀 SQL IDE, `FETCH FIRST N ROWS` 페이지네이션, `V$` 모니터링 뷰, `ANALYZE TABLE`, `ALTER INDEX REBUILD`, 트랜잭션 |
| **SQL Server** | `mssql`(tedious) | 풀 SQL IDE, `TOP N` / `OFFSET FETCH` 페이지네이션, `sys.dm_*` DMV, `UPDATE STATISTICS`, `DBCC CHECKDB`, 트랜잭션, Azure SQL 자동 감지 |
| **SQLite** | `bun:sqlite` / `node:sqlite`(런타임 선택) | 풀 SQL IDE, 파일 기반·인메모리 데이터베이스(서버 로컬 파일) |
| **libSQL** | 드라이버 없음, HTTP(Hrana 프로토콜, `POST /v2/pipeline`, 8080) | 풀 SQL IDE. 자체 운영 libSQL 서버(`sqld`)와 Turso Cloud에 동일한 type-id로 접속합니다. 네트워크를 통해 도달하는 SQLite 방언으로, `dbstat` 기반의 실제 테이블·인덱스 바이트 크기를 읽습니다. 자격 증명은 비밀번호가 아니라 auth 토큰입니다. 유지보수 작업은 `REINDEX`와 무결성 체크뿐 — 서버가 `VACUUM`, `ANALYZE`, `PRAGMA optimize`, `PRAGMA wal_checkpoint`를 명시적으로 거부하므로 해당 컨트롤을 제공하지 않습니다 |
| **DuckDB** | `@duckdb/node-api`(네이티브 N-API 애드온, 플랫폼별 약 68MB 바인딩) | 앱이 돌아가는 서버의 로컬 DuckDB 파일 또는 `:memory:`에 대한 풀 SQL IDE. `EXPLAIN (FORMAT JSON)` 물리 계획 트리, `duckdb_*` 카탈로그 인스펙션, `pragma_storage_info` 블록 할당에서 얻는 실제 테이블별 바이트 크기, 드라이버 자체의 `interrupt()`를 통한 쿼리 취소. 유지보수 작업은 `VACUUM`·`ANALYZE`·`CHECKPOINT` 세 개 — `REINDEX`는 이 엔진에서 파서 오류이고 `PRAGMA integrity_check`도 `PRAGMA optimize`도 존재하지 않습니다. 느린 쿼리 로그도 세션 목록도 없습니다. DuckDB는 둘 다 공개하지 않으므로, 0을 보여주는 대신 그 사실을 알려줍니다. 데이터베이스 파일은 정확히 하나의 OS 프로세스만 열 수 있고 읽기 전용 모드에서도 거부되므로, 이 인스턴스가 잡고 있는 파일을 다른 Studio 인스턴스가 열 수 없습니다 |
| **MongoDB** | `mongodb` | JSON 쿼리 편집기, 컬렉션 작업(find, aggregate, insert, update, delete) |
| **Couchbase** | 드라이버 없음, HTTP(Query + 관리 REST) | 풀 SQL++ IDE, EXPLAIN, 버킷/스코프/컬렉션 탐색기, `INFER` 컬럼 추론, 쓰기 후 읽기 일관성, `UPDATE STATISTICS` / `BUILD INDEX` / 요청 취소 |
| **ClickHouse** | 드라이버 없음, HTTP(SQL 인터페이스, 8123) | 풀 SQL IDE, JSON EXPLAIN 계획 트리, 시스템 테이블 스키마 인스펙션, `OPTIMIZE TABLE` / 테이블 통계 / 쿼리 취소 |
| **Apache Druid** | 드라이버 없음, HTTP(`POST /druid/v2/sql`) | 읽기 전용 SQL IDE, 네이티브 쿼리 EXPLAIN 트리, `INFORMATION_SCHEMA` 데이터소스 인스펙션, `sys.*` 모니터링. Druid SQL에는 `UPDATE`, `DELETE`, `CREATE TABLE`이 없고 유지보수 작업도 없습니다 — 데이터소스는 편집기가 아니라 인제스트로 바뀌기 때문입니다 |
| **Elasticsearch** | 드라이버 없음, HTTP(`POST /_sql?format=json`, 9200) | 읽기 전용 SQL IDE, 매핑 기반 인덱스/필드 탐색기, 클러스터 상태와 인덱스별 문서 수·저장 크기. EXPLAIN 없음, 유지보수 작업 없음, 느린 쿼리·세션 패널 없음. Elasticsearch SQL에는 `OFFSET`도 없어서 두 번째 페이지를 요청할 수 없습니다 |
| **OpenSearch** | 드라이버 없음, HTTP(`POST /_plugins/_sql`, 9200) | Elasticsearch와 같은 provider 모듈이 제공하는 같은 읽기 전용 SQL IDE와 탐색기. 여기서는 `LIMIT n OFFSET m`이 동작하므로 페이지네이션도 쓸 수 있습니다 |
| **Apache Trino** | 드라이버 없음, HTTP(클라이언트 프로토콜, `POST /v1/statement`, 8080) | 설정된 모든 카탈로그에 대한 풀 SQL IDE, `EXPLAIN (FORMAT JSON)` 계획 트리, 접속이 고정한 카탈로그의 `information_schema` 트리, `system.runtime` + `jmx` 모니터링, 실제 `SHOW STATS` 행 수, 쿼리 취소와 `kill_query` 유지보수. Trino는 쿼리 엔진이자 그 자체로 아무것도 저장하지 않으므로 어디에도 주키·외래키·인덱스를 선언하지 않습니다(ER 다이어그램은 상자만, 인라인 행 편집 비활성, 크기 패널은 카탈로그 이름을 보여줍니다). 실패한 문도 HTTP 200으로 도착하고, 인증을 끈 클러스터에서도 평문 HTTP 위의 비밀번호는 거부됩니다 |
| **Apache Cassandra** | `cassandra-driver`(순수 JS, 네이티브 모듈 없음) | 네이티브 프로토콜(9042) 위의 CQL IDE, 파티션 키와 클러스터링 키를 표시하는 키페이스 탐색기, `system_views` 개요·가동 시간·실행 중 문. 접속에는 **`localDataCenter`가 필수**입니다(드라이버가 없으면 접속을 거부). EXPLAIN 없음(CQL 문법에 키워드가 없음), 취소 없음(프로토콜에 취소 프레임이 없음), 유지보수 없음(모든 작업이 `nodetool` JMX 호출). 그리고 **행 수도 크기도 표시하지 않습니다**: Cassandra가 공개하는 수치는 플러시된 파일의 파티션 추정치와 정수 메비바이트뿐이라, 잘못된 수를 보여주는 것보다 아무것도 보여주지 않는 쪽을 골랐습니다 |
| **Redis** | `ioredis` | 명령어 편집기, 키 탐색기, INFO 기반 모니터링 |

> **전송 계층 보안은 엔진별 기능이 아니라 횡단 기능입니다.** SSH 터널은 provider가 접속하기 전에 열리고 접속지가 로컬 엔드포인트로 다시 쓰이므로 엔진에 의존하지 않습니다. 호스트와 포트로 설정한 모든 접속에 적용됩니다. 접속 문자열로 입력한 접속(MongoDB, Couchbase, ClickHouse, libSQL에서 선택 가능)은 호스트와 포트가 모두 없으므로 터널링되지 않습니다. SQLite와 DuckDB도 마찬가지입니다. SSL/TLS 패널은 이를 표시하는 모든 엔진에서 실제로 동작합니다 — 표시하지 않는 파일 기반 엔진 SQLite, DuckDB, 내장 LibreDB를 제외하면. Trino에서는 선택이 아니라 필수에 가깝습니다. 코디네이터가 평문 HTTP 위의 비밀번호를 거부하기 때문입니다.

### 실무용 SQL 편집기

- **Monaco 엔진**: VS Code와 같은 코어.
- **스키마를 아는 자동 완성**: 테이블명, 컬럼명, SQL 키워드.
- **멀티 탭**: 탭마다 독립적인 실행 상태.
- **비주얼 EXPLAIN**: 실행 계획을 그래프로 보여주고 병목을 찾습니다.
- **인터랙티브 ER 다이어그램**: 실제 외래 키를 간선으로 그리고, 카디널리티 표시, MiniMap, 테이블 검색, PNG/SVG 내보내기. ELK.js 자동 계층 레이아웃.
- **스키마 diff와 마이그레이션**: 접속 간·스냅샷 간 비교를 색상 표시로, 마이그레이션 SQL 자동 생성(PostgreSQL, MySQL, SQLite, Oracle, SQL Server, ClickHouse의 컬럼 변경).
- **스냅샷 타임라인**: 아무 두 지점이나 클릭해 스키마 변천을 비교합니다.

<p align="center">
  <img src="public/screenshots/erd-diagram.png" alt="ER 다이어그램" width="100%" />
</p>

### 데이터베이스 에이전트(읽기 전용)

Studio AI의 중심은 편집기 옆의 에이전트 레일입니다. 목적을 한 문장으로 적고(“어느 부서에 사람이 가장 많을까?”, “이 쿼리는 왜 느릴까?”) Start를 누르면, 접속된 데이터베이스에 SQL을 걸고 결과를 읽고, 마지막에 **모든 주장이 그 근거가 된 읽기를 인용하는** 리포트를 정리합니다.

- **읽기 전용, 그것도 데이터베이스가 보증합니다**: 에이전트가 실행하는 모든 문은 에이전트 전용 감사 파이프라인을 통과하며(정책 판정·감사 이벤트·예산 계상이 드라이버에 닿기 전에 발생), 읽기 전용 실행 프로파일에서 돌아갑니다(PostgreSQL은 읽기 전용 트랜잭션, SQLite는 문마다 `PRAGMA query_only` 재선언, DuckDB는 `READ_ONLY` 핸들에 SQL 레벨 가드까지). 쓰기와 DDL은 데이터베이스에 도착하기 전에 거부되고, `EXPLAIN ANALYZE`는 문을 실제로 실행해버리므로 기본 비허용입니다.
- **에이전트 모드는 PostgreSQL·SQLite·DuckDB만**: 읽기 전용 프로파일은 데이터베이스 측 기능으로 보증되므로 그것을 구현한 provider에만 있습니다. 나머지 엔진에서 실행은 `engine-unsupported`로 끝납니다. **Plan** 모드는 도구를 쓰지 않고 데이터베이스에도 접근하지 않으므로 어떤 접속에서든 쓸 수 있습니다.
- **세 가지 워크플로**: Investigate(질문 답변), Optimize(추정 계획 비교와 인덱스·쿼리 재작성 제안), Assess(테이블 프로파일링 — 개수만 읽고 값은 절대 읽지 않음).
- **마음대로 움직이지 않습니다**: 에이전트가 스스로 Run을 시작하거나, 에디터에 쓰거나, 제안한 문을 실행하지 않습니다. 적용 여부는 클릭입니다.
- **근거 없으면 주장도 없습니다**: 인용 없는 주장은 기록될 수 없습니다.
- **상한이 있고 화면에 보입니다**: Run당 20개 문, DB 시간 60초, 읽기당 200행, 실행 5분.
- **모델은 내 것**: Gemini(기본), OpenAI, Ollama, OpenAI 호환 임의 엔드포인트.

스탠드얼론 버전 한정으로, 임베드용 `@libredb/studio` 패키지에는 에이전트 UI가 들어 있지 않습니다. 가이드: [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md) · 외부로 나가는 데이터: [`docs/AGENT_DATA_FLOW.md`](docs/AGENT_DATA_FLOW.md)

### 그 외의 AI 기능(선택 · 내 모델로)

- **벤더 중립**: 기본은 Gemini 2.5 Flash. OpenAI, 로컬/OpenAI 호환 엔드포인트(Ollama / LM Studio / LiteLLM) 지원.
- **쿼리 안전성 분석**: DELETE, DROP, TRUNCATE 등 파괴적 작업을 실행 전에 평가.
- **실행 계획 설명**: EXPLAIN을 평문으로 번역하고 개선안을 제시.
- **데이터 프로파일러 요약**: 컬럼 통계를 문장으로.

**모델을 설정하지 않으면 AI는 전혀 호출되지 않습니다.** `LLM_*` 미설정 기본 상태에서는 네트워크 밖으로 나가는 것이 없습니다.

### 데이터 작업

- **가상화 그리드**(TanStack): 100만 행 규모도 매끄럽게 렌더링.
- **인라인 편집**: 더블 클릭으로 값 갱신(단일 테이블 행 업데이트를 SQL이 지원하는 엔진에서만 표시).
- **피벗 테이블**: 클라이언트 사이드 집계 5종, 해당하는 SQL도 생성.
- **차트 8종**: 막대, 선, 원, 영역, 분산, 히스토그램, 스택 막대, 스택 영역(Recharts). 설정 저장 및 재사용 가능.
- **내보내기**: CSV, JSON.

### 분석 · 개발 도구

- **AI 데이터 프로파일러**: 컬럼 통계(NULL 비율, 카디널리티, 최소·최대, 샘플 값)와 AI 요약을 원클릭으로.
- **ORM 코드 생성**: 라이브 스키마에서 TypeScript interface, Zod schema, Prisma model, Go struct, Python dataclass, Java POJO 생성.
- **테스트 데이터 생성**: 30종 이상의 시맨틱 추론(이메일, 전화번호, 이름, 주소 등)으로 INSERT 문 또는 MongoDB insertMany JSON 출력.
- **데이터베이스 문서화**: 라이브 스키마에서 검색 가능한 데이터 사전 자동 생성, Markdown 내보내기.

### 인증과 SSO: 전부 MIT 빌드에 포함

- **두 가지 모드**: 로컬 이메일/비밀번호, 또는 OIDC 싱글 사인온. 환경 변수로 전환.
- **프로바이더 무관**: Auth0, Keycloak, Okta, Azure AD, Zitadel, Google 등 OIDC를 따르는 곳이면 어디든.
- **PKCE**: Authorization Code Flow + S256.
- **롤 매핑**: claim 기반 설정, `realm_access.roles` 같은 중첩 경로 지원.

### DBA 운영 도구(관리자 전용)

7개 탭 모니터링(개요, 성능, 쿼리, 세션, 테이블, 스토리지, 커넥션 풀), 시계열 추세 그래프, 5~60초 자동 갱신, 임계값 색상 경고, 원클릭 `VACUUM` / `ANALYZE` / `REINDEX` / `UPDATE STATISTICS` / `DBCC CHECKDB` / `ALTER INDEX REBUILD`. 조직 전체의 쿼리 감사 로그 포함.

## 설치 방법

| 채널 | 명령어 |
| :--- | :--- |
| **Docker** | `docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest` |
| **npx** | `npx @libredb/studio` |
| **Helm** | `helm install libredb oci://ghcr.io/libredb/charts/libredb-studio` |
| **Homebrew** | `brew trust libredb/tap && brew install libredb/tap/libredb-studio` |
| **deb / rpm** | `sudo dpkg -i libredb-studio_<version>_amd64.deb` |
| **Snap** | `sudo snap install libredb-studio` |
| **winget** | `winget install LibreDB.Studio` |
| **Desktop 앱 (Linux, AppImage)** | `chmod +x libredb-studio-desktop-<version>-linux-x64.AppImage && ./libredb-studio-desktop-<version>-linux-x64.AppImage` |
| **Desktop 앱 (Debian/Ubuntu)** | `sudo apt install ./libredb-studio-desktop-<version>_amd64.deb` |
| **Desktop 앱 (Flatpak)** | `flatpak --user remote-add --if-not-exists flatpark https://dl.flatpark.org/flatpark.flatpakrepo`<br>`flatpak --user install flatpark org.libredb.Studio` |

`brew trust`는 처음 한 번만 필요합니다(Homebrew 6+; “unknown command”가 뜨면 먼저 `brew update`). Docker, Helm, Snap은 무설정이고, 첫 실행 시 생성되는 관리자 비밀번호는 각각 컨테이너 로그, Pod 로그, `sudo snap logs libredb-studio`에 출력됩니다. 채널별 상세(명령어, 설정, systemd 사용법, Docker 이미지 태그 체계)는 [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md)에 있습니다.

원클릭 템플릿: Railway, Dokploy, CapRover, Sealos, Kubero, Cosmos, DigitalOcean Marketplace, Unraid Community Apps, Render Blueprint, Fly.io, Koyeb. 목록은 [`docs/CHANNELS.md`](docs/CHANNELS.md).

Kubernetes용 OpenShift / OLM Operator bundle도 제공합니다.

### 내 제품에 임베드하기

```bash
npm i @libredb/studio
```

Studio는 npm 패키지로도 배포되므로 앱 안에 직접 Embed할 수 있습니다. 사용자를 위해 데이터베이스를 만드는 제품이라면, 편집기가 가장 쓸모 있는 곳은 그 안입니다.

**Studio의 보안 헤더를 내 Next.js 설정에서 쓰기.** `@libredb/studio/security` 서브패스는 이 정책을 순수 데이터로 공개합니다. `securityHeaders()`가 돌려주는 것은 `Record<string, string>`일 뿐이고, 정의 모듈은 아무것도 import하지 않습니다. 경로 별칭도 Studio 런타임도 아직 없는 `next.config.ts`에서 읽어도 안전합니다.

```ts
// next.config.ts
import { securityHeaders } from "@libredb/studio/security";

export default {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: Object.entries(securityHeaders()).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};
```

옵션: `reportOnly`는 강제 대신 `Content-Security-Policy-Report-Only`를 보냅니다. `hsts: false`는 HSTS 비활성화(객체 전달 시 커스터마이즈). `allowEval`은 React **개발** 빌드가 필요로 하는 `'unsafe-eval'`을 추가합니다. `monacoVsPath`는 Monaco 번들이 동일 오리진이 아닐 때 그 origin을 더합니다. `extra`는 디렉티브별로 자체 소스를 병합합니다.

계승하기 전에 정책 자체를 읽으세요. 이 CSP는 인라인 스크립트를 허용합니다. 모든 문서 라우트가 정적으로 프리렌더되어 하이드레이션 인라인 스크립트에 nonce를 붙일 수 없기 때문입니다. 따라서 이 정책이 묶는 것은 주입된 스크립트가 데이터를 **어디로 보낼 수 있는지**이지, 실행할 수 있는지 여부가 아닙니다. 이 트레이드오프는 [`docs/SECURITY.md`](docs/SECURITY.md)에 정리되어 있습니다.

## 유료와의 경계에 대하여

Studio가 MIT인 것은 어디에나 놓여야 하기 때문입니다. 유료는 libredb-platform이고, 거기서 파는 것은 “운영의 대행” — 호스팅, 테넌트 관리, 과금, 지원 — 이며 유료 벽 너머로 옮겨진 기능이 아닙니다.

**업그레이드 이유를 만들기 위해 경계 너머로 옮겨진 기능은 하나도 없습니다.** SSO, RBAC, 쿼리 감사 로그, ER 다이어그램, AI 기능, NoSQL 엔진군, 전부 MIT 빌드에 들어가 있습니다.

## 테스트와 품질

- 유닛, API, 통합, hooks, 컴포넌트, E2E의 6개 계층
- **행 커버리지 100%**, CI 필수 게이트. 내려가면 머지할 수 없습니다
- SonarCloud 품질 게이트
- 릴리스마다 Node 24 / 26 스모크 테스트

```bash
bun run test           # 전체 테스트
bun run test:e2e       # Playwright(빌드 필요)
bun run test:coverage  # 커버리지 리포트
```

## 문서

상세 문서의 현재 언어는 영어뿐입니다.

- [아키텍처](docs/ARCHITECTURE.md) · [데이터베이스 프로바이더](docs/DATABASE_PROVIDERS.md) · [엔진별 레퍼런스](docs/providers/README.md)
- [API 문서](docs/API_DOCS.md) · [OIDC 설정](docs/OIDC.md) · [스토리지](docs/STORAGE.md)
- [Helm 차트](docs/HELM_CHART.md) · [배포 채널](docs/CHANNELS.md) · [데이터베이스 추가하기](docs/ADDING_A_PROVIDER.md)

## 기여

Issue도 PR도 환영합니다. 한국어로도 좋습니다. 먼저 [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.

데이터베이스 엔진을 추가한다면 [`docs/ADDING_A_PROVIDER.md`](docs/ADDING_A_PROVIDER.md)를 참고하세요. 코드·문서·테스트는 같은 PR 안에서 함께 맞춰져야 합니다.

## 라이선스

[MIT](LICENSE). CLA 없음, 엔터프라이즈 에디션 없음, 아끼는 것 없음.
