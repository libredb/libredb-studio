// Object-browser fixture for the MongoDB provider (issue #789).
//
// The `mongo` image runs every .js in /docker-entrypoint-initdb.d through mongosh, once,
// on a FRESH data directory only, so an already-initialized container has to be recreated
// before an edit here takes effect. The recipe for applying it to a running container by
// hand is in docs/providers/mongodb.md.
//
// Every object below exists to make one claim about the ENGINE re-measurable rather than
// merely plausible. Measured on MongoDB 8.3.9.
//
// 1. `readings` is a TIME SERIES collection, so `listCollections` answers a third value
//    for `type`: "timeseries", beside "collection" and "view". A provider that classified
//    on `type === "collection"` would lose it from both the count and the listing at once,
//    which is the invisible absence standing ruling 5a exists for. The classifier is
//    therefore "view versus everything else", and this collection is what refutes the
//    other spelling instead of leaving it merely unattractive.
// 2. `by_thing` is created on BOTH `customers` and `orders` in the same database, and both
//    succeed. An index name is unique per COLLECTION, not per database, so an index is not
//    a first-class container-level object here and no `index` kind is declared. Creating
//    the same name twice on ONE collection is refused, which is the other half of that
//    measurement.
// 3. `systemetrics` starts with the letters "system" and not with "system.". A provider
//    excluding internal namespaces by the prefix "system" rather than "system." would hide
//    a collection a person created. The reserved prefix really is "system." with the dot:
//    creating `system.mine` is refused with "not authorized", measured.
// 4. `configstore` is a DATABASE whose name starts with "config". The three reserved
//    database names are `admin`, `config` and `local` and they are excluded by exact name,
//    never by prefix, or this database would vanish from the tree.
// 5. The `oddnames` DATABASE holds three collections whose names differ from one another
//    only in a character JSON ESCAPES. A quote and a backslash are both legal in a
//    collection name, measured (only the null byte and `$` are refused), and the three
//    sort one way by code point and another way by `JSON.stringify`. They live in their
//    own database so the `app` counts stay about the kinds rather than about sorting.
// 6. `active_customers` is a view, and its `options.viewOn` and `options.pipeline` come
//    back on the same `listCollections` call that classified it. Phase 2 reads them.

const app = db.getSiblingDB("app");

app.customers.insertMany([
  { name: "Ada", city: "Istanbul" },
  { name: "Grace", city: "Ankara" },
  { name: "Alan", city: "Istanbul" },
]);
app.orders.insertMany([
  { customer: "Ada", total: 120 },
  { customer: "Grace", total: 80 },
]);
app.systemetrics.insertMany([{ metric: "latency_ms", value: 12 }]);

app.customers.createIndex({ city: 1 }, { name: "by_thing" });
app.orders.createIndex({ total: 1 }, { name: "by_thing" });

app.createCollection("active_customers", {
  viewOn: "customers",
  pipeline: [{ $match: { city: "Istanbul" } }],
});

app.createCollection("readings", { timeseries: { timeField: "ts", metaField: "sensor" } });
app.readings.insertMany([
  { ts: new Date("2026-09-11T00:00:00Z"), sensor: "s1", value: 1 },
  { ts: new Date("2026-09-11T00:01:00Z"), sensor: "s1", value: 2 },
]);

const oddnames = db.getSiblingDB("oddnames");
// Legal, measured: MongoDB refuses only the null byte and `$` in a collection name. By
// code point these sort `x"a` (0x22), `x-a` (0x2D), `x\a` (0x5C); by JSON.stringify they
// sort `x-a`, `x"a`, `x\a`, because escaping rewrites the first two as a backslash.
oddnames.createCollection('x"a');
oddnames.createCollection("x-a");
oddnames.createCollection("x\\a");

const configstore = db.getSiblingDB("configstore");
configstore.settings.insertMany([{ key: "theme", value: "dark" }]);

print("libredb object fixture applied: app, configstore, oddnames");
