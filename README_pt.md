<p align="center">
  <img src="public/logo.svg" width="200" alt="LibreDB Studio Logo" />
</p>

<h1 align="center">LibreDB Studio</h1>

<p align="center">
  <strong>O editor de banco de dados que roda ao lado dos seus dados, não no seu notebook.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README_zh.md">简体中文</a> ·
  <a href="README_ja.md">日本語</a> ·
  <a href="README_es.md">Español</a> ·
  <a href="README_ur.md">اردو</a> ·
  <a href="README_hi.md">हिन्दी</a> ·
  <b>Português (Brasil)</b>
</p>

<p align="center">
  Citado pelo projeto PostgreSQL:
  <a href="https://www.postgresql.org/about/news/libredb-studio-an-open-source-self-hosted-sql-ide-for-postgresql-in-the-browser-3368/">News</a>
  ·
  <a href="https://wiki.postgresql.org/wiki/PostgreSQL_Clients#LibreDB_Studio">PostgreSQL Clients</a>
  ·
  <a href="https://www.postgresql.org/download/products/1/">Software Catalogue</a>
  ·
  <a href="https://wiki.postgresql.org/wiki/Community_Guide_to_PostgreSQL_GUI_Tools#LibreDB_Studio">Community Guide to GUI Tools</a>
</p>
<p align="center">
  Também listado na documentação oficial de
  <a href="https://redis.io/docs/latest/develop/tools/#libredb-studio">Redis</a>,
  <a href="https://clickhouse.com/docs/integrations/connectors/tools/gui#libredb-studio">ClickHouse</a>,
  <a href="https://mariadb.com/docs/server/clients-and-utilities/graphical-and-enhanced-clients/libredb-studio">MariaDB</a>,
  <a href="https://trino.io/ecosystem/client-application#libredb-studio">Trino</a>,
  <a href="https://cloudberry.apache.org/docs/ecosystem/sql-clients/libredb-studio/">Apache Cloudberry</a>,
  <a href="https://docs.yugabyte.com/stable/integrations/tools/libredb-studio/">YugabyteDB</a>,
  <a href="https://www.dragonflydb.io/docs/integrations/libredb-studio">DragonflyDB</a>
  e
  <a href="https://opensearch.org/community-projects/">OpenSearch</a>
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

## Início rápido

Um IDE SQL completo com um único comando — sem clonar, sem compilar.

```bash
# Docker (recomendado)
docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest

# ou com Node.js 24+ (sem Docker)
npx @libredb/studio
```

Depois abra **http://localhost:3000**. Na primeira execução, a senha de administrador é impressa no log, sem nenhum arquivo de configuração.

> Se o navegador não acessar por localhost nem por HTTPS (por exemplo `http://192.168.x.x:3000` na rede local), também defina `AUTH_COOKIE_SECURE=false`. Sem isso, o health check passa, mas o login falha em silêncio e você volta para a tela de login repetidamente.

Precisa de Helm, Homebrew, Snap, winget ou deb/rpm? Veja [Instalação](#instalação) abaixo.

## Por que mais uma ferramenta de banco de dados

Você cria um Postgres em uma plataforma gerenciada e ele fica pronto em quarenta segundos.

Depois você quer ver o que tem dentro. Aí expõe uma porta na internet, ou instala um cliente desktop e abre um túnel SSH, ou desiste e volta para a linha de comando. O banco levou quarenta segundos; abrir uma janela para ele consumiu a tarde.

Agora multiplique isso pela escala. A aplicação usa Postgres, documentos vão no Mongo, cache no Redis, eventos no ClickHouse. Quatro bancos, quatro clientes, quatro conjuntos de credenciais. Na segunda-feira entra alguém novo e, antes de escrever a primeira linha de código, precisa descobrir onde cada dado mora, caçar strings de conexão na wiki e em três chats privados, esperar acesso à VPN e instalar uma ferramenta diferente para cada motor.

**Os bancos de dados já se mudaram.** Foram para Kubernetes, nuvens gerenciadas, VPCs de clientes que só se alcançam passando por um bastion. **Mas as ferramentas para lê-los não se mudaram junto.** Continuam sendo aplicativos desktop: pesados, com licença por assento, que precisam ser instalados antes de usar e que assumem um único banco, um único notebook e uma pessoa que nunca troca de máquina.

O LibreDB Studio segue o caminho oposto: **a ferramenta vai até os dados, em vez de trazer os dados até a ferramenta.**

Levada a sério, essa frase deixa de ser preferência e vira especificação.

- O editor precisa rodar no navegador, porque os dados não estão na sua máquina — e seus colegas também não.
- Precisa abrir no celular, porque a falha que exige uma consulta não espera você ligar o notebook.
- Precisa ser implantado como infraestrutura (container, Helm chart, Operator, template de um clique), porque é assim que tudo que vive ao lado de um banco é instalado.
- Precisa poder ser embutido, porque o lugar mais útil para um editor é dentro do produto que criou o banco.
- Nada pode ficar reservado. Você não pode colocar uma ferramenta com licença por assento e recursos em camadas em cada ambiente que administra. **Se o login único custa extra, a ferramenta deixa de ser implantável por padrão.**

> MIT aqui não é generosidade: é um requisito rígido dessa arquitetura.

## Capacidades principais

### Dezesseis motores, uma única interface

PostgreSQL · MySQL · Oracle · SQL Server · SQLite · libSQL · DuckDB · MongoDB · Redis · Couchbase · ClickHouse · Apache Druid · Elasticsearch · OpenSearch · Apache Trino · Apache Cassandra

Todos os motores SQL compartilham o mesmo explorador de esquema, diagramas ER, comparação de esquema e painéis de monitoramento. MongoDB e Redis não são motores SQL: não têm diagrama ER nem comparação de esquema. Druid, Elasticsearch, OpenSearch e Trino são exceções duplas: suas interfaces SQL sobre HTTP não têm uma forma de URI que este build saiba interpretar, então se configuram por host e porta, e as migrações geradas explicam a limitação em vez de inventar DDL para um motor cujo SQL não tem comandos de alteração de coluna. O mesmo vale para coleções sem esquema no Couchbase. O diagrama ER dos clusters de busca tem caixas, mas não linhas: os índices não declaram chaves estrangeiras — e no modelo do motor não há nenhuma para declarar.

| Banco de dados | Driver | Capacidades |
| :--- | :--- | :--- |
| **PostgreSQL** | `pg` | IDE SQL completo, planos EXPLAIN, transações, cancelamento de consultas (`pg_cancel_backend`) |
| **MySQL** | `mysql2` | IDE SQL completo, EXPLAIN, transações, cancelamento de consultas (`KILL QUERY`) |
| **Oracle** | `oracledb` (modo Thin) | IDE SQL completo, paginação com `FETCH FIRST N ROWS`, views de monitoramento `V$`, `ANALYZE TABLE`, `ALTER INDEX REBUILD`, transações |
| **SQL Server** | `mssql` (tedious) | IDE SQL completo, paginação com `TOP N` / `OFFSET FETCH`, DMVs `sys.dm_*`, `UPDATE STATISTICS`, `DBCC CHECKDB`, transações, detecção automática de Azure SQL |
| **SQLite** | `bun:sqlite` / `node:sqlite` (conforme o runtime) | IDE SQL completo, em arquivo ou em memória |
| **libSQL** | Sem driver, HTTP puro (protocolo Hrana, `POST /v2/pipeline`, porta 8080) | IDE SQL completo. O mesmo type-id conecta tanto a um servidor libSQL próprio (`sqld`) quanto ao Turso Cloud. É o dialeto SQLite pela rede, e com `dbstat` informa o tamanho real em bytes de tabelas e índices. A credencial é um auth token, não uma senha. Só há duas operações de manutenção — reindex e verificação de integridade: `VACUUM`, `ANALYZE` e `PRAGMA optimize` são rejeitados pelo servidor |
| **DuckDB** | `@duckdb/node-api` (complemento nativo N-API, cerca de 68 MB por plataforma) | IDE SQL completo sobre arquivos DuckDB locais ou `:memory:`, executando no mesmo servidor da aplicação. Árvore de plano físico com `EXPLAIN (FORMAT JSON)`, introspecção do catálogo `duckdb_*`, tamanho real por tabela a partir da alocação de blocos de `pragma_storage_info`, e cancelamento de consultas via `interrupt()` do próprio driver. Três operações de manutenção: `VACUUM`, `ANALYZE` e `CHECKPOINT`. Aqui `REINDEX` é erro de sintaxe, e `PRAGMA integrity_check` e `PRAGMA optimize` não existem, então não são oferecidos. Não há log de consultas lentas nem lista de sessões: o DuckDB não expõe nenhum dos dois, então esses painéis dizem isso em vez de mostrar 0. Um arquivo de banco aceita apenas um processo do sistema operacional (mesmo em modo leitura), então uma segunda instância do Studio não pode abrir o arquivo que a primeira já tem aberto |
| **MongoDB** | `mongodb` | Editor de consultas JSON e operações em coleções (find, aggregate, insert, update, delete) |
| **Couchbase** | Sem driver, HTTP puro (REST de Query e de administração) | IDE SQL++ completo, EXPLAIN, explorador de buckets, scopes e coleções, inferência de campos com `INFER` |
| **ClickHouse** | Sem driver, HTTP puro (interface SQL, porta 8123) | IDE SQL completo, árvore EXPLAIN em JSON, introspecção de esquema por tabelas de sistema, `OPTIMIZE TABLE` |
| **Apache Druid** | Sem driver, HTTP puro (`POST /druid/v2/sql`) | IDE SQL somente leitura, árvore EXPLAIN da consulta nativa, introspecção via `INFORMATION_SCHEMA`, monitoramento com `sys.*` |
| **Elasticsearch** | Sem driver, HTTP puro (`POST /_sql?format=json`, porta 9200) | IDE SQL somente leitura, explorador de índices e campos baseado no mapping, saúde do cluster e contagem de documentos e tamanho por índice. Sem EXPLAIN, sem operações de manutenção e sem painéis de consultas lentas ou sessões. O SQL do Elasticsearch também não tem `OFFSET`, então não dá para pedir a segunda página de resultados |
| **OpenSearch** | Sem driver, HTTP puro (`POST /_plugins/_sql`, porta 9200) | O mesmo módulo de provider que o Elasticsearch, com o mesmo IDE somente leitura e o mesmo explorador. Aqui `LIMIT n OFFSET m` funciona, então a paginação está disponível |
| **Apache Trino** | Sem driver, HTTP puro (protocolo de cliente, `POST /v1/statement`, porta 8080) | IDE SQL completo sobre todos os catálogos configurados, árvore de esquema via `information_schema` do catálogo fixado na conexão, monitoramento com `system.runtime` e `jmx`, contagens reais de linhas via `SHOW STATS`, cancelamento de consultas e manutenção com `kill_query`. Trino é um motor de consultas e não armazena dados, então não declara chaves primárias, estrangeiras nem índices em lugar nenhum: o diagrama ER tem caixas sem linhas, a edição inline fica desativada e o painel de capacidade lista catálogos em vez de inventar um tamanho. Consultas com falha também retornam HTTP 200; e mesmo com autenticação desligada no cluster, senha sobre HTTP em texto plano continua sendo rejeitada |
| **Apache Cassandra** | `cassandra-driver` (JavaScript puro, sem módulos nativos) | IDE CQL sobre o protocolo nativo (porta 9042), explorador de keyspaces com chaves de partição e de clustering marcadas, resumo via `system_views`, uptime e consultas em execução. A conexão **exige `localDataCenter`**: sem isso o driver se recusa a conectar. Não há EXPLAIN (a gramática CQL simplesmente não tem essa palavra-chave), não há cancelamento de consultas (o protocolo não tem frame de cancelamento) e não há operações de manutenção (compaction, repair e flush são operações JMX do `nodetool`). E **não mostra contagem de linhas nem tamanho**: o que o Cassandra consegue dar é uma estimativa de partições a partir dos arquivos já gravados em disco (uma tabela de 500 linhas foi lida como 143) e inteiros em MiB (uma tabela de 19.476 bytes aparece como `1 MiB`), então preferimos não mostrar nada a mostrar um número errado |
| **Redis** | `ioredis` | Editor de comandos, explorador de chaves, monitoramento baseado em INFO |

> **A segurança do transporte é transversal — não depende do motor.** O túnel SSH é estabelecido antes do provider abrir a conexão, e a conexão é reescrita para o endpoint local: por isso não depende do motor e vale para qualquer conexão configurada com host e porta. Conexões preenchidas com connection string (MongoDB, Couchbase e ClickHouse permitem) não têm host nem porta, então não passam pelo túnel; SQLite e DuckDB também não têm nenhum dos dois. O painel SSL/TLS hoje tem efeito em PostgreSQL, MySQL, SQL Server, Couchbase, ClickHouse, Druid, Elasticsearch, OpenSearch e Trino; no Trino não é opcional, porque o coordinator rejeita senhas sobre HTTP em texto plano. Oracle, MongoDB e Redis ignoram essa opção — se o tráfego desses três vai cifrado depende de como a connection string está escrita, não do que você escolhe no diálogo.

> Redis numa interface pensada para SQL se sustenta numa convenção. `getSchema()` agrupa prefixos de chaves em "tabelas" usando `SCAN`, que não bloqueia (**nunca `KEYS *`**); saúde e métricas vêm de `INFO`; consultas lentas e sessões, de `SLOWLOG GET` e `CLIENT LIST`.

### Editor SQL profissional

- **Motor Monaco**: o mesmo núcleo do VS Code.
- **Autocompletar com conhecimento do esquema**: tabelas, colunas e palavras-chave.
- **Workspace com abas**: cada aba com seu próprio estado de execução.
- **EXPLAIN visual**: planos de execução gráficos para achar gargalos.
- **Diagramas ER interativos**: grafo do esquema com arestas de chaves estrangeiras reais, rótulos de cardinalidade, minimapa, busca e filtro de tabelas, modo compacto e exportação PNG e SVG. Layout hierárquico automático com ELK.js.
- **Comparação de esquema e migrações**: compare snapshots ou esquemas de conexões diferentes lado a lado. Visão de diff com cores (adicionado, removido, modificado) e geração automática de SQL de migração para PostgreSQL, MySQL, SQLite, Oracle e SQL Server, além de alterações de coluna no ClickHouse.
- **Linha do tempo de snapshots**: linha horizontal com snapshots do esquema. Escolha dois pontos e compare na hora, para acompanhar a evolução do esquema.

### Agente de banco de dados (somente leitura)

A interface principal de IA é um **painel de agente** ao lado do editor. Você define um objetivo — *"qual departamento tem mais funcionários?"*, *"por que esta consulta está lenta?"* — e pressiona Start. A execução redige SQL contra o banco conectado, lê os resultados e escreve um relatório cujas afirmações citam esses resultados.

### Outros recursos com modelo (opcional, com seu próprio modelo)

- **Compatível com qualquer LLM**: por padrão usa Gemini, e funciona com OpenAI, Ollama e qualquer endpoint compatível com OpenAI (LM Studio, LiteLLM, vLLM).
- **Análise de segurança de consultas**: avaliação de risco antes da execução para comandos destrutivos (DELETE, DROP, TRUNCATE).
- **Explicação de consultas**: planos EXPLAIN traduzidos para linguagem simples, com sugestões de otimização.
- **Conhecimento do esquema**: o esquema do banco conectado é enviado como contexto, então a explicação cita suas próprias tabelas e colunas.
- **Resumo do profiler de dados**: estatísticas por coluna do profiler, redigidas em prosa. Esse contexto inclui `min` e `max` de cada coluna — valores reais dos seus dados; veja [Agent Data Flow](docs/AGENT_DATA_FLOW.md).

### Gestão de dados

- **Grade universal**: renderização virtualizada (TanStack) para milhões de linhas.
- **Edição inline**: duplo clique para atualizar valores direto na grade, nos motores cujo SQL permite update de linha em tabela única (nos demais o controle não aparece).
- **Filtros por coluna**: filtros de texto sobre os resultados, para explorar sem reescrever a consulta.
- **Tabela dinâmica interativa**: pivot no cliente com cinco funções de agregação (COUNT, SUM, AVG, MIN, MAX) e geração do SQL equivalente.
- **Exportação**: CSV e JSON na hora.
- **Oito tipos de gráfico**: barras, linhas, pizza, área, dispersão, histograma, barras empilhadas e área empilhada, com Recharts. Agrupamento por hora, dia, semana, mês ou ano, com configurações de gráfico que são salvas e recarregadas.

### Ferramentas de análise e desenvolvimento

- **Profiler de dados**: profiling de tabela em um clique, com estatísticas por coluna (percentual de nulos, cardinalidade, mínimo e máximo, valores de amostra) e resumos narrativos gerados pelo modelo.
- **Gerador de código ORM**: interfaces TypeScript, schemas Zod, models Prisma, structs Go, dataclasses Python e POJOs Java a partir do esquema real das tabelas.
- **Gerador de dados de teste**: dados fictícios com conhecimento do esquema e mais de 30 inferências semânticas de coluna (email, telefone, nome, endereço e outras). Produz INSERTs ou JSON para `insertMany` do MongoDB.
- **Documentação do banco**: dicionário de dados gerado e pesquisável, a partir do esquema real, com documentação assistida por modelo e exportação para Markdown.

### Autenticação e SSO — tudo na versão MIT

- **Dois modos de autenticação**: usuário e senha locais, ou login único via OpenID Connect (OIDC), alternáveis com uma variável de ambiente.
- **OIDC agnóstico de provedor**: funciona com qualquer provedor compatível com OIDC — Auth0, Keycloak, Okta, Azure AD, Zitadel, Google e outros.
- **Segurança PKCE**: Authorization Code Flow com Proof Key for Code Exchange (S256).
- **Mapeamento automático de papéis**: mapeamento por claims configurável, com notação de ponto para claims aninhados (por exemplo `realm_access.roles`).
- **Logout no provedor**: ao sair, encerra tanto a sessão JWT local quanto a do provedor de identidade.

### Ferramentas de manutenção para DBA (somente admin)

- **Painel de monitoramento ao vivo**: sete abas — resumo, desempenho, consultas, sessões, tabelas, armazenamento e pool de conexões.
- **Gráficos de tendência**: métricas em tempo real (conexões, taxa de acerto de cache, buffer pool, deadlocks) com histórico em buffer circular e refresh automático configurável entre 5 e 60 segundos.
- **Alertas por limiar**: indicadores de saúde com cores (saudável, aviso, crítico) para taxa de acerto de cache, uso de conexões, deadlocks e uso do buffer pool.
- **Manutenção em um clique**: `VACUUM`, `ANALYZE`, `REINDEX`, `UPDATE STATISTICS`, `DBCC CHECKDB` e `ALTER INDEX REBUILD`, conforme o motor.
- **Registro de auditoria**: histórico completo de cada consulta executada na organização.

## Instalação

| Método | Comando |
| :--- | :--- |
| **Docker** | `docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest` |
| **npx** | `npx @libredb/studio` |
| **Helm** | `helm install libredb oci://ghcr.io/libredb/charts/libredb-studio` |
| **Homebrew** | `brew trust libredb/tap && brew install libredb/tap/libredb-studio` |
| **Snap** | `sudo snap install libredb-studio` |
| **winget** | `winget install LibreDB.Studio` |
| **deb / rpm** (servidor, com serviço systemd) | [Página de releases](https://github.com/libredb/libredb-studio/releases/latest) |
| **App desktop** (AppImage / deb) | [Página de releases](https://github.com/libredb/libredb-studio/releases/latest). Janela nativa, com o servidor rodando como sidecar local e sem tela de login. **Não é o pacote de servidor da linha anterior.** |
| **App desktop** (Flatpak, em sandbox) | `flatpak --user remote-add --if-not-exists flatpark https://dl.flatpark.org/flatpark.flatpakrepo`<br>`flatpak --user install flatpark org.libredb.Studio` |

`brew trust` roda uma vez (requer Homebrew 6+; se disser que o comando não existe, execute `brew update` antes). Docker, Helm e Snap não precisam de configuração: a senha de admin da primeira execução é impressa no log do container, no log do pod e em `sudo snap logs libredb-studio`, respectivamente. Instruções completas de cada canal (comandos, configuração, uso com systemd, modelo de tags das imagens Docker) estão em [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

Templates de deploy com um clique: Railway, Dokploy, CapRover, Sealos, Kubero, Cosmos, DigitalOcean Marketplace, Unraid Community Apps, Render Blueprint, Fly.io e Koyeb. A lista completa está em [`docs/CHANNELS.md`](docs/CHANNELS.md).

Para Kubernetes também há um bundle de Operator para OpenShift e OLM.

### Embutir no seu produto

```bash
npm i @libredb/studio
```

O Studio também é publicado como pacote npm, então pode ser embutido diretamente na sua aplicação. Se o seu produto cria bancos de dados para os usuários, esse é o lugar onde o editor mais ajuda.

## Onde traçamos a linha de cobrança

O Studio é MIT porque precisa poder ir a qualquer lugar. O que é cobrado é o libredb-platform — e o que ele vende é alguém operando por você: hosting, multi-tenancy, faturamento e suporte. Não é um recurso bloqueado atrás de um paywall.

**Nenhuma capacidade foi movida para o outro lado dessa linha só para fabricar motivo de upgrade.** Login único, RBAC, auditoria de consultas, diagramas ER, recursos de IA e todos os motores NoSQL estão na versão MIT.

## Testes e qualidade

- Sete camadas de testes: unitários, de API, de integração, de hooks, de segurança, de evals e de componentes, além dos end-to-end
- **100% de cobertura de linhas**, e isso é um gate rígido no CI. Se a cobertura cair, o merge é bloqueado
- Quality gate do SonarCloud
- Smoke tests em Node 24 e 26 a cada release

```bash
bun run test           # todos os testes
bun run test:e2e       # Playwright (requer build antes)
bun run test:coverage  # relatório de cobertura
```

## Documentação

O material aprofundado está, por enquanto, só em inglês:

- [Arquitetura](docs/ARCHITECTURE.md) · [Providers de banco de dados](docs/DATABASE_PROVIDERS.md) · [Referência por motor](docs/providers/README.md)
- [Documentação da API](docs/API_DOCS.md) · [Configuração OIDC](docs/OIDC.md) · [Camada de storage](docs/STORAGE.md)
- [Helm Chart](docs/HELM_CHART.md) · [Canais de distribuição](docs/CHANNELS.md) · [Adicionar um banco de dados](docs/ADDING_A_PROVIDER.md)

## Contribuir

Issues e pull requests são bem-vindos — pode escrever em português sem problema. Comece por [CONTRIBUTING.md](CONTRIBUTING.md).

Para adicionar um motor de banco de dados, veja [`docs/ADDING_A_PROVIDER.md`](docs/ADDING_A_PROVIDER.md). Código, documentação e testes vão juntos no mesmo pull request.

## Licença

[MIT](LICENSE). Sem CLA, sem edição enterprise, sem nada reservado.
