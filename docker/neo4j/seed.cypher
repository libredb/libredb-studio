// Seed graph for the neo4j service in database-compose.yml, written for this repository.
// Load it once the service is healthy (docker/neo4j/README.md):
//   docker exec -i libredb-neo4j cypher-shell -u neo4j -p password123 < docker/neo4j/seed.cypher
// Every statement ends with a semicolon and runs in its own transaction. The first one empties
// the graph, so a second load gives the same graph rather than a doubled one.

MATCH (n) DETACH DELETE n;

CREATE INDEX person_name IF NOT EXISTS FOR (p:Person) ON (p.name);

CREATE CONSTRAINT service_id IF NOT EXISTS FOR (s:Service) REQUIRE s.id IS UNIQUE;

// Teams.
CREATE (:Team {name: 'Platform', founded: date('2019-03-01')}),
       (:Team {name: 'Payments', founded: date('2020-07-15')}),
       (:Team {name: 'Search', founded: date('2021-01-04')}),
       (:Team {name: 'Data', founded: date('2022-11-30')});

// People. Non-ASCII names on purpose: they reach the grid and the index as they are.
CREATE (:Person {name: 'Ayse Yilmaz', age: 34, active: true, skills: ['go', 'kubernetes']}),
       (:Person {name: 'Mehmet Demir', age: 41, active: true, skills: ['java', 'kafka']}),
       (:Person {name: 'Zeynep Kaya', age: 29, active: false, skills: ['python']}),
       (:Person {name: 'Emre Çelik', age: 38, active: true, skills: ['rust', 'postgres']}),
       (:Person {name: 'Elif Şahin', age: 27, active: true, skills: []}),
       (:Person {name: 'Jonas Berg', age: 45, active: true, skills: ['scala', 'spark']}),
       (:Person {name: 'Ana Souza', age: 31, active: true, skills: ['typescript']}),
       (:Person {name: 'Kenji Sato', age: 36, active: false, skills: ['c', 'linux']}),
       (:Person {name: 'Lena Fischer', age: 33, active: true, skills: ['sql', 'dbt']}),
       (:Person {name: 'Omar Haddad', age: 40, active: true, skills: ['elixir']});

// Services. One per team at least; `types` holds one property of every value type the
// provider maps (spec 3.4). A byte array is not seeded: no core Cypher function produces one,
// and the APOC plugin is not installed on this image.
CREATE (:Service {id: 'gateway', tier: 1, uptime: 99.95}),
       (:Service {id: 'auth', tier: 1, uptime: 99.99}),
       (:Service {id: 'ledger', tier: 1, uptime: 99.9}),
       (:Service {id: 'checkout', tier: 2, uptime: 99.5}),
       (:Service {id: 'indexer', tier: 2, uptime: 98.7}),
       (:Service {id: 'query', tier: 2, uptime: 99.1}),
       (:Service {id: 'warehouse', tier: 3, uptime: 97.0}),
       (:Service {
         id: 'types',
         aString: 'plain text',
         anInteger: 42,
         beyondDoubles: 9007199254740993,
         minInteger: -9223372036854775808,
         aFloat: 0.1,
         notANumber: 0.0 / 0.0,
         aBoolean: false,
         aList: [1, 2, 3],
         aDate: date('2026-10-03'),
         aLocalTime: localtime('13:45:30.123456789'),
         aTime: time('13:45:30.123456789+03:00'),
         aLocalDateTime: localdatetime('2026-10-03T13:45:30.123456789'),
         aDateTime: datetime({year: 2026, month: 10, day: 3, hour: 13, minute: 45, second: 30, nanosecond: 123456789, timezone: 'Europe/Istanbul'}),
         aDuration: duration('P1Y2M3DT4H5M6.789S'),
         aCartesianPoint: point({x: 1.5, y: -2.25}),
         aWgs84Point: point({longitude: 28.9784, latitude: 41.0082})
       });

// Names that need quoting in Cypher: a space, and a backtick inside the name.
CREATE (:`Weird Label` {name: 'with a space', rank: 1}),
       (:`Weird Label` {name: 'second', rank: 2}),
       (:`Back``tick` {name: 'with a backtick'}),
       (:`Back``tick` {name: 'another'});

// A label and a relationship type with the same name.
CREATE (:Shared {id: 1})-[:Shared]->(:Shared {id: 2});

// A label whose nodes carry no property at all.
CREATE (:Marker), (:Marker);

// Membership: everyone in one team, a few in two.
UNWIND [
  ['Ayse Yilmaz', 'Platform'], ['Mehmet Demir', 'Payments'], ['Zeynep Kaya', 'Search'],
  ['Emre Çelik', 'Platform'], ['Elif Şahin', 'Data'], ['Jonas Berg', 'Data'],
  ['Ana Souza', 'Payments'], ['Kenji Sato', 'Platform'], ['Lena Fischer', 'Data'],
  ['Omar Haddad', 'Search'], ['Ayse Yilmaz', 'Search'], ['Emre Çelik', 'Data'],
  ['Ana Souza', 'Platform'], ['Lena Fischer', 'Search'], ['Jonas Berg', 'Payments']
] AS pair
MATCH (p:Person {name: pair[0]}), (t:Team {name: pair[1]})
CREATE (p)-[:MEMBER_OF {since: date('2023-01-01'), role: CASE WHEN p.age > 39 THEN 'lead' ELSE 'engineer' END}]->(t);

// Ownership: every service has one owning team.
UNWIND [
  ['Platform', 'gateway'], ['Platform', 'auth'], ['Payments', 'ledger'],
  ['Payments', 'checkout'], ['Search', 'indexer'], ['Search', 'query'],
  ['Data', 'warehouse'], ['Data', 'types']
] AS pair
MATCH (t:Team {name: pair[0]}), (s:Service {id: pair[1]})
CREATE (t)-[:OWNS]->(s);

// Dependencies between services, with a cycle (checkout, ledger, auth) on purpose.
UNWIND [
  ['gateway', 'auth', true], ['checkout', 'ledger', true], ['checkout', 'auth', true],
  ['ledger', 'auth', true], ['auth', 'checkout', false], ['query', 'indexer', true],
  ['gateway', 'query', false], ['indexer', 'warehouse', false], ['warehouse', 'ledger', false],
  ['gateway', 'checkout', true], ['query', 'auth', true], ['indexer', 'auth', false]
] AS edge
MATCH (a:Service {id: edge[0]}), (b:Service {id: edge[1]})
CREATE (a)-[:DEPENDS_ON {critical: edge[2]}]->(b);

// The quoted labels take part in relationships too, so a tree click on them reaches a path.
MATCH (w:`Weird Label` {name: 'with a space'}), (b:`Back``tick` {name: 'with a backtick'}), (s:Service {id: 'gateway'})
CREATE (w)-[:DEPENDS_ON {critical: false}]->(s),
       (b)-[:DEPENDS_ON {critical: false}]->(s),
       (w)-[:OWNS]->(b);

MATCH (w:`Weird Label` {name: 'second'}), (b:`Back``tick` {name: 'another'})
CREATE (b)-[:MEMBER_OF]->(w);
