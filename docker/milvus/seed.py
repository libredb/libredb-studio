#!/usr/bin/env python3
"""Seeds the milvus service of database-compose.yml for the vector fixtures (docker/milvus/README.md).

  seed.py --uri URI --credentials DIR    create what is missing; a second run on a seeded server does no work
  seed.py --uri URI --verify             read every seeded object back, print a report, exit 1 on a difference
  seed.py --uri URI --manifest           print the manifest of what the seed inserts, as JSON on stdout

Ported from the design research's seed. The data is deterministic (fixed numpy seeds) apart from the auto_id keys
of docs_int64, so every fixture addresses rows by seq. root signs in with Milvus's documented default password,
the server's built-in default, which no compose file, user.yaml or environment variable sets; the provider's
default-credential warning is tested against it. The users reader and nobody get passwords generated into DIR on
the first run. Progress goes to stderr, so --manifest prints nothing but the manifest on stdout.
"""

import argparse
import json
import math
import secrets
import sys
import time
from pathlib import Path

import ml_dtypes
import numpy as np
from pymilvus import DataType, Function, FunctionType, MilvusClient

ROOT_TOKEN = "root:Milvus"
USERS = ("reader", "nobody")
READER_ROLE = "reader_role"
READER_GRANTS = (("CollectionReadOnly", "*"), ("DatabaseReadOnly", "*"))
SAMPLE = 5

TYPE_NAMES = {
    DataType.INT32: "Int32",
    DataType.INT64: "Int64",
    DataType.VARCHAR: "VarChar",
    DataType.JSON: "JSON",
    DataType.ARRAY: "Array",
    DataType.FLOAT_VECTOR: "FloatVector",
    DataType.FLOAT16_VECTOR: "Float16Vector",
    DataType.BFLOAT16_VECTOR: "BFloat16Vector",
    DataType.BINARY_VECTOR: "BinaryVector",
    DataType.INT8_VECTOR: "Int8Vector",
    DataType.SPARSE_FLOAT_VECTOR: "SparseFloatVector",
}


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def unit(rng, n, dim):
    v = rng.standard_normal((n, dim)).astype(np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def finite(value):
    return value if math.isfinite(value) else None


def wire(dtype, value):
    """The value as pymilvus inserts it."""
    if dtype == DataType.FLOAT_VECTOR:
        return np.asarray(value, dtype=np.float32)
    if dtype == DataType.FLOAT16_VECTOR:
        return np.asarray(value, dtype=np.float32).astype(np.float16)
    if dtype == DataType.BFLOAT16_VECTOR:
        return np.asarray(value, dtype=np.float32).astype(ml_dtypes.bfloat16)
    if dtype == DataType.BINARY_VECTOR:
        return bytes(value)
    if dtype == DataType.INT8_VECTOR:
        return np.asarray(value, dtype=np.int8)
    if dtype == DataType.SPARSE_FLOAT_VECTOR:
        return {int(index): float(np.float32(item)) for index, item in value.items()}
    return value


def stored(dtype, value):
    """The value as the server stores it, in JSON: the expected cells of the fixtures are derived from this."""
    if dtype in (DataType.FLOAT_VECTOR, DataType.FLOAT16_VECTOR, DataType.BFLOAT16_VECTOR):
        return [finite(float(item)) for item in wire(dtype, value)]
    if dtype == DataType.BINARY_VECTOR:
        return list(bytes(value))
    if dtype == DataType.INT8_VECTOR:
        return [int(item) for item in value]
    if dtype == DataType.SPARSE_FLOAT_VECTOR:
        return {str(index): item for index, item in sorted(wire(dtype, value).items())}
    return value


def wait_index(c, name):
    for _ in range(600):
        done = True
        for index in c.list_indexes(name):
            described = c.describe_index(name, index)
            if described.get("state") not in ("Finished", None) or described.get("pending_index_rows", 0):
                done = False
        if done:
            return
        time.sleep(1)
    raise RuntimeError(f"the index on {name} did not finish in 600 s")


class Field:
    def __init__(self, name, dtype, **params):
        self.name = name
        self.dtype = dtype
        self.params = params

    def manifest(self):
        entry = {"name": self.name, "type": TYPE_NAMES[self.dtype]}
        for key, value in self.params.items():
            if key == "element_type":
                entry[key] = TYPE_NAMES[value]
            elif key == "is_primary":
                entry["primary"] = value
            elif key == "is_partition_key":
                entry["partition_key"] = value
            else:
                entry[key] = value
        return entry


class Collection:
    """One seeded collection: its schema, its indexes, its rows as a function of a fixed seed, and how it loads."""

    def __init__(self, db, name, description, fields, indexes, rows, *, key, rule, auto_id=False, dynamic=False,
                 loaded=True, partitions=(), num_partitions=None, properties=None, functions=(), stages=None,
                 added=(), sample=SAMPLE):
        self.db = db
        self.name = name
        self.description = description
        self.fields = fields
        self.indexes = indexes
        self.rows = rows
        self.key = key
        self.rule = rule
        self.auto_id = auto_id
        self.dynamic = dynamic
        self.loaded = loaded
        self.partitions = partitions
        self.num_partitions = num_partitions
        self.properties = properties or {}
        self.functions = functions
        self.stages = stages
        self.added = added
        self.sample = sample

    def types(self):
        return {field.name: field.dtype for field in (*self.fields, *self.added)}

    def create(self, c):
        schema = c.create_schema(auto_id=self.auto_id, enable_dynamic_field=self.dynamic, description=self.description)
        for field in self.fields:
            schema.add_field(field.name, field.dtype, **field.params)
        for name, source, output in self.functions:
            schema.add_function(Function(name=name, function_type=FunctionType.BM25, input_field_names=[source],
                                         output_field_names=[output]))
        options = {}
        if self.num_partitions is not None:
            options["num_partitions"] = self.num_partitions
        if self.properties:
            options["properties"] = self.properties
        c.create_collection(self.name, schema=schema, **options)
        for partition in self.partitions:
            c.create_partition(self.name, partition)
        if self.stages is not None:
            self.stages(c, self)
        else:
            self.insert(c)
        c.flush(self.name)
        params = c.prepare_index_params()
        for field, (index_type, metric, index_params) in self.indexes.items():
            params.add_index(field, index_type=index_type, metric_type=metric, params=index_params)
        c.create_index(self.name, params)
        wait_index(c, self.name)
        if self.loaded:
            c.load_collection(self.name)
        else:
            c.release_collection(self.name)

    def insert(self, c):
        types = self.types()
        batches = {}
        for row, partition in self.rows():
            batches.setdefault(partition, []).append({key: wire(types.get(key), value) for key, value in row.items()})
        for partition, rows in batches.items():
            options = {"partition_name": partition} if partition else {}
            for start in range(0, len(rows), 1000):
                c.insert(self.name, rows[start:start + 1000], **options)

    def manifest(self):
        types = self.types()
        rows = self.rows()
        sample = []
        for seq, (row, partition) in enumerate(rows[:self.sample]):
            entry = {"seq": seq, "key": row.get(self.key) if self.key else None,
                     "values": {key: stored(types.get(key), value) for key, value in row.items()}}
            if partition:
                entry["partition"] = partition
            sample.append(entry)
        return {
            "description": self.description,
            "rule": self.rule,
            "rows": len(rows),
            "loaded": self.loaded,
            "auto_id": self.auto_id,
            "dynamic": self.dynamic,
            "key": self.key,
            "partitions": list(self.partitions),
            "num_partitions": self.num_partitions,
            "properties": self.properties,
            "functions": [{"name": name, "type": "BM25", "input": [source], "output": [output]}
                          for name, source, output in self.functions],
            "fields": [field.manifest() for field in self.fields] + [{**field.manifest(), "added": True}
                                                                     for field in self.added],
            "indexes": {field: {"type": index_type, "metric": metric, "params": params}
                        for field, (index_type, metric, params) in self.indexes.items()},
            "sample": sample,
        }


# -- the research's collections ------------------------------------------------------------------------------------

def docs_int64_rows():
    rng = np.random.default_rng(1)
    vectors = unit(rng, 2000, 8)
    groups = ["alpha", "beta", "gamma"]
    colors = ["red", "green", "blue"]
    rows = []
    for i in range(2000):
        row = {
            "seq": i,
            "vec": vectors[i],
            "title": f"doc {i:04d} {groups[i % 3]}",
            "meta": {"i": i, "group": groups[i % 3], "score": round(float(i % 97) / 97, 4),
                     "nested": {"even": i % 2 == 0}},
            "tags": [i % 5, i % 7, i],
            "maybe_count": None if i % 4 == 0 else i,
            "color": colors[i % 3],
        }
        if i % 10 == 0:
            row["big_int"] = 2**60 + i
        rows.append((row, "part_a" if i % 2 == 0 else "part_b"))
    return rows


def docs_varchar_rows():
    rng = np.random.default_rng(2)
    floats = rng.standard_normal((500, 8)).astype(np.float32)
    bits = rng.integers(0, 256, size=(500, 2), dtype=np.uint8)
    int8s = rng.integers(-128, 128, size=(500, 8), dtype=np.int8)
    rows = []
    for i in range(500):
        indices = rng.choice(1000, size=4, replace=False)
        rows.append(({
            "pk": f"vc-{i:04d}",
            "label": ["north", "south", "east", "west"][i % 4],
            "f16": floats[i],
            "bf16": floats[i],
            "bin": bits[i].tobytes(),
            "sparse": {int(j): float(round(rng.random() + 0.01, 4)) for j in indices},
            "i8": int8s[i],
        }, None))
    return rows


def fts_texts(n=200):
    subjects = ["the cat", "a dog", "the database", "a vector index", "the query planner", "a search engine",
                "the cluster", "a small team", "the operator", "a new release"]
    verbs = ["reads", "writes", "loads", "searches", "ranks", "indexes", "compacts", "replicates", "flushes",
             "releases"]
    objects = ["the logs", "many rows", "sparse vectors", "every partition", "the schema", "short texts",
               "a large collection", "the metrics", "old segments", "fresh data"]
    tails = ["quickly", "at night", "with care", "in parallel", "on demand", "every hour", "without errors",
             "under load", "for the users", "again"]
    return [f"{subjects[i % 10]} {verbs[(i // 10) % 10]} {objects[(i * 7) % 10]} {tails[(i * 3 + i // 100) % 10]}"
            for i in range(n)]


def unloaded_big_rows():
    rng = np.random.default_rng(4)
    rows = []
    for start in range(0, 50000, 5000):
        vectors = rng.standard_normal((5000, 128)).astype(np.float32)
        rows.extend(({"id": start + j, "vec": vectors[j], "bucket": (start + j) % 100}, None) for j in range(5000))
    return rows


def notes_rows():
    rng = np.random.default_rng(5)
    vectors = rng.standard_normal((100, 4)).astype(np.float32)
    return [({"id": i, "vec": vectors[i], "body": f"note {i} in probe_db"}, None) for i in range(100)]


# -- the collections this repository adds ------------------------------------------------------------------------

EDGE_ROWS = [
    {"id": 1, "label": "range-ends",
     "f32": [3.4028234663852886e38, -1.401298464324817e-45, 1.1754943508222875e-38, 0.1],
     "f16": [65504.0, -65504.0, 6.103515625e-05, 5.960464477539063e-08],
     "bf16": [3.3895313892515355e38, -1.1754943508222875e-38, 0.1, -2.0],
     "bin": [0x00, 0x00], "i8": [-128, 127, 0, -1], "sp": {0: 1e-30, 4294967294: 0.5}},
    {"id": 2, "label": "all-ones",
     "f32": [0.1, 0.2, 0.3, 0.4], "f16": [0.1, 0.2, 0.3, 0.4], "bf16": [0.1, 0.2, 0.3, 0.4],
     "bin": [0xff, 0xff], "i8": [1, 2, 3, 4], "sp": {7: 0.1, 8: 0.2}},
    {"id": 3, "label": "non-finite-score",
     "f32": [-0.0, 1.0, -1.0, 1e-7], "f16": [-0.0, 1.0, -1.0, 0.000123], "bf16": [-0.0, 1.0, -1.0, 1e-7],
     "bin": [0x55, 0xaa], "i8": [-128, -128, 127, 127], "sp": {1: 3.4e38}},
    {"id": 4, "label": "precision",
     "f32": [16777217.0, 0.333333343267, 2.5, -7.0], "f16": [2049.0, 0.333, 2.5, -7.0],
     "bf16": [257.0, 0.333, 2.5, -7.0], "bin": [0x01, 0x80], "i8": [0, 0, 0, 1], "sp": {100: 1.0000001}},
    {"id": 5, "label": "metric-probe",
     "f32": [3.0, 4.0, 0.0, 0.0], "f16": [3.0, 4.0, 0.0, 0.0], "bf16": [3.0, 4.0, 0.0, 0.0],
     "bin": [0x0f, 0xf0], "i8": [3, 4, 0, 0], "sp": {2: 1.0}},
]


def pk_partitioned_rows():
    rng = np.random.default_rng(9)
    vectors = rng.standard_normal((2000, 8)).astype(np.float32)
    return [({"id": j, "tenant": j % 100, "vec": vectors[j]}, None) for j in range(2000)]


def large_topk_rows():
    rng = np.random.default_rng(8)
    vectors = unit(rng, 100, 8)
    return [({"id": j, "vec": vectors[j]}, None) for j in range(100)]


# Rows 1 to 4 go in while zeta is a dynamic key, one row per insert; AddCollectionField then adds a static zeta, and
# rows 7 and 8 go in with it. Old rows then hold both a static null and a dynamic value.
SHADOWED_BEFORE = [
    {"id": 1, "title": "dynamic zeta 1", "vec": [0.1, 0.2, 0.3, 0.4], "zeta": 1},
    {"id": 2, "title": "no zeta", "vec": [0.2, 0.3, 0.4, 0.5], "alpha": 5},
    {"id": 3, "title": "dynamic zeta 8", "vec": [0.3, 0.4, 0.5, 0.6], "zeta": 8, "big": 2**60 + 1},
    {"id": 4, "title": "no zeta", "vec": [0.4, 0.5, 0.6, 0.7]},
]
SHADOWED_AFTER = [
    {"id": 7, "title": "static zeta 70", "vec": [0.7, 0.8, 0.9, 1.0], "zeta": 70},
    {"id": 8, "title": "static zeta null", "vec": [0.8, 0.9, 1.0, 1.1], "zeta": None},
]


def shadowed_stages(c, spec):
    types = spec.types()
    for row in SHADOWED_BEFORE:
        c.insert(spec.name, [{key: wire(types.get(key), value) for key, value in row.items()}])
    c.add_collection_field(spec.name, field_name="zeta", data_type=DataType.INT64, nullable=True)
    for row in SHADOWED_AFTER:
        c.insert(spec.name, [{key: wire(types.get(key), value) for key, value in row.items()}])


def wide_768_rows():
    rng = np.random.default_rng(10)
    vectors = unit(rng, 1000, 768)
    return [({"id": j, "vec": vectors[j]}, None) for j in range(1000)]


HNSW = {"M": 16, "efConstruction": 64}
SMALL_HNSW = {"M": 8, "efConstruction": 32}

COLLECTIONS = [
    Collection(
        "default", "docs_int64", "int64 auto_id key, scalar fields of every kind, a dynamic field",
        [Field("id", DataType.INT64, is_primary=True), Field("seq", DataType.INT64),
         Field("vec", DataType.FLOAT_VECTOR, dim=8), Field("title", DataType.VARCHAR, max_length=256),
         Field("meta", DataType.JSON),
         Field("tags", DataType.ARRAY, element_type=DataType.INT64, max_capacity=8),
         Field("maybe_count", DataType.INT32, nullable=True)],
        {"vec": ("HNSW", "COSINE", HNSW)}, docs_int64_rows,
        key=None, auto_id=True, dynamic=True, partitions=("part_a", "part_b"),
        rule="keys above 2^53 assigned by the server, rows addressed by seq; partitions; JSON, array and null cells"),
    Collection(
        "default", "docs_varchar", "varchar key, every vector type",
        [Field("pk", DataType.VARCHAR, is_primary=True, max_length=64), Field("label", DataType.VARCHAR, max_length=64),
         Field("f16", DataType.FLOAT16_VECTOR, dim=8), Field("bf16", DataType.BFLOAT16_VECTOR, dim=8),
         Field("bin", DataType.BINARY_VECTOR, dim=16), Field("sparse", DataType.SPARSE_FLOAT_VECTOR),
         Field("i8", DataType.INT8_VECTOR, dim=8)],
        {"f16": ("HNSW", "L2", SMALL_HNSW), "bf16": ("HNSW", "IP", SMALL_HNSW),
         "bin": ("BIN_IVF_FLAT", "HAMMING", {"nlist": 16}), "sparse": ("SPARSE_INVERTED_INDEX", "IP", {}),
         "i8": ("HNSW", "L2", SMALL_HNSW)},
        docs_varchar_rows, key="pk", rule="a cell and a search of every vector type and of four metrics"),
    Collection(
        "default", "fts", "BM25 full text search",
        [Field("id", DataType.INT64, is_primary=True),
         Field("text", DataType.VARCHAR, max_length=1024, enable_analyzer=True, analyzer_params={"type": "english"}),
         Field("text_sparse", DataType.SPARSE_FLOAT_VECTOR)],
        {"text_sparse": ("SPARSE_INVERTED_INDEX", "BM25", {})},
        lambda: [({"id": i, "text": text}, None) for i, text in enumerate(fts_texts())],
        key="id", functions=(("text_bm25", "text", "text_sparse"),),
        rule="a BM25 function's output field, searched with text"),
    Collection(
        "default", "unloaded_big", "50,000 rows of 128 dimensions, released",
        [Field("id", DataType.INT64, is_primary=True), Field("vec", DataType.FLOAT_VECTOR, dim=128),
         Field("bucket", DataType.INT32)],
        {"vec": ("IVF_FLAT", "L2", {"nlist": 256})}, unloaded_big_rows, key="id", loaded=False,
        rule="a released collection: a search refused as not loaded, Load with its preview on a copy"),
    Collection(
        "default", "scratch", "the one writable collection, empty at seed time",
        [Field("id", DataType.INT64, is_primary=True), Field("vec", DataType.FLOAT_VECTOR, dim=8),
         Field("note", DataType.VARCHAR, max_length=512)],
        {"vec": ("AUTOINDEX", "L2", {})}, lambda: [], key="id", dynamic=True,
        rule="the shared writable collection, compared on schema, configuration, aliases and load state only"),
    Collection(
        "default", "edge_values", "every vector type at its range ends",
        [Field("id", DataType.INT64, is_primary=True), Field("label", DataType.VARCHAR, max_length=32),
         Field("f32", DataType.FLOAT_VECTOR, dim=4), Field("f16", DataType.FLOAT16_VECTOR, dim=4),
         Field("bf16", DataType.BFLOAT16_VECTOR, dim=4), Field("bin", DataType.BINARY_VECTOR, dim=16),
         Field("i8", DataType.INT8_VECTOR, dim=4), Field("sp", DataType.SPARSE_FLOAT_VECTOR)],
        {"f32": ("FLAT", "L2", {}), "f16": ("HNSW", "L2", SMALL_HNSW), "bf16": ("HNSW", "L2", SMALL_HNSW),
         "bin": ("BIN_FLAT", "HAMMING", {}), "i8": ("HNSW", "L2", SMALL_HNSW),
         "sp": ("SPARSE_INVERTED_INDEX", "IP", {})},
        lambda: [(dict(row), None) for row in EDGE_ROWS], key="id", sample=len(EDGE_ROWS),
        rule="the copy loop's edge rows, the non-finite score of a 3.4e38 sparse self-search, (3,4) from the origin"),
    Collection(
        "default", "pk_partitioned", "a partition key over 1,024 partitions",
        [Field("id", DataType.INT64, is_primary=True), Field("tenant", DataType.INT64, is_partition_key=True),
         Field("vec", DataType.FLOAT_VECTOR, dim=8)],
        {"vec": ("FLAT", "L2", {})}, pk_partitioned_rows, key="id", num_partitions=1024,
        rule="partitions/list past the row cap, and partitionNames refused on a partition-key collection"),
    Collection(
        "default", "large_topk", "the property query_mode set to large_topk",
        [Field("id", DataType.INT64, is_primary=True), Field("vec", DataType.FLOAT_VECTOR, dim=8)],
        {"vec": ("HNSW", "L2", SMALL_HNSW)}, large_topk_rows, key="id", properties={"query_mode": "large_topk"},
        rule="large_topk detected by its exact property"),
    Collection(
        "default", "shadowed", "a static zeta added over rows holding a dynamic zeta",
        [Field("id", DataType.INT64, is_primary=True), Field("title", DataType.VARCHAR, max_length=64),
         Field("vec", DataType.FLOAT_VECTOR, dim=4)],
        {"vec": ("FLAT", "L2", {})},
        lambda: [(dict(row), None) for row in SHADOWED_BEFORE + SHADOWED_AFTER], key="id", dynamic=True,
        stages=shadowed_stages, added=(Field("zeta", DataType.INT64, nullable=True),),
        sample=len(SHADOWED_BEFORE) + len(SHADOWED_AFTER),
        rule="the merge rule's live collision of a static and a dynamic key"),
    Collection(
        "default", "wide_768", "1,000 normalised embeddings of 768 dimensions",
        [Field("id", DataType.INT64, is_primary=True), Field("vec", DataType.FLOAT_VECTOR, dim=768)],
        {"vec": ("HNSW", "COSINE", HNSW)}, wide_768_rows, key="id",
        rule="the result byte budget"),
    Collection(
        "probe_db", "notes", "a second database, small and loaded",
        [Field("id", DataType.INT64, is_primary=True), Field("vec", DataType.FLOAT_VECTOR, dim=4),
         Field("body", DataType.VARCHAR, max_length=128)],
        {"vec": ("FLAT", "L2", {})}, notes_rows, key="id",
        rule="a database other than default, which reader may not read"),
]


def connect(uri, db="default"):
    return MilvusClient(uri=uri, token=ROOT_TOKEN, db_name=db)


def password(credentials, user):
    file = credentials / f"{user}.password"
    if not file.exists():
        file.write_text(secrets.token_hex(16) + "\n")
        file.chmod(0o644)
    return file.read_text().strip()


def ensure_users(c, credentials):
    users = c.list_users()
    for user in USERS:
        if user in users:
            if not (credentials / f"{user}.password").exists():
                sys.exit(f"{user} exists but {credentials}/{user}.password is missing: remove the milvus-data and "
                         "milvus-credentials volumes to start over")
            continue
        c.create_user(user, password(credentials, user))
        log(f"user {user} created")
    if READER_ROLE not in c.list_roles():
        c.create_role(READER_ROLE)
        log(f"role {READER_ROLE} created")
    held = {(grant["privilege"], grant["object_name"]) for grant in c.describe_role(READER_ROLE)["privileges"]
            if grant["db_name"] == "default"}
    for privilege, collection in READER_GRANTS:
        if (privilege, collection) not in held:
            c.grant_privilege_v2(READER_ROLE, privilege, collection, db_name="default")
            log(f"{READER_ROLE} granted {privilege} on default/{collection}")
    if READER_ROLE not in c.describe_user("reader").get("roles", ()):
        c.grant_role("reader", READER_ROLE)
        log(f"reader granted {READER_ROLE}")


def seed(uri, credentials):
    root = connect(uri)
    log(f"server version {root.get_server_version()}")
    if "probe_db" not in root.list_databases():
        root.create_database("probe_db")
        log("database probe_db created")
    for spec in COLLECTIONS:
        c = connect(uri, spec.db)
        if c.has_collection(spec.name):
            log(f"{spec.db}.{spec.name} exists, kept")
            continue
        started = time.time()
        spec.create(c)
        log(f"{spec.db}.{spec.name} created in {time.time() - started:.1f} s")
    ensure_users(root, Path(credentials))
    log("seed finished")


def verify(uri):
    root = connect(uri)
    problems = []
    report = {"server_version": root.get_server_version(), "collections": {}}
    for spec in COLLECTIONS:
        c = connect(uri, spec.db)
        where = f"{spec.db}.{spec.name}"
        if not c.has_collection(spec.name):
            problems.append(f"{where} is missing")
            continue
        state = c.get_load_state(spec.name)["state"].name
        wanted_state = "Loaded" if spec.loaded else "NotLoad"
        if state != wanted_state:
            problems.append(f"{where} is {state}, not {wanted_state}")
        if state == "Loaded":
            count = int(c.query(spec.name, filter="", output_fields=["count(*)"],
                                consistency_level="Strong")[0]["count(*)"])
        else:
            count = int(c.get_collection_stats(spec.name)["row_count"])
        if count != len(spec.rows()):
            problems.append(f"{where} holds {count} rows, not {len(spec.rows())}")
        described = c.describe_collection(spec.name)
        names = {field["name"] for field in described["fields"]}
        missing = sorted({field.name for field in (*spec.fields, *spec.added)} - names)
        if missing:
            problems.append(f"{where} lacks the fields {missing}")
        for key, value in spec.properties.items():
            found = described.get("properties", {}).get(key)
            if found != value:
                problems.append(f"{where} has the property {key} {found!r}, not {value!r}")
        if spec.num_partitions is not None:
            partitions = len(c.list_partitions(spec.name))
            if partitions != spec.num_partitions:
                problems.append(f"{where} has {partitions} partitions, not {spec.num_partitions}")
        report["collections"][where] = {"load_state": state, "rows": count}
    users = root.list_users()
    problems.extend(f"user {user} is missing" for user in USERS if user not in users)
    report["problems"] = problems
    print(json.dumps(report, indent=1, sort_keys=True))
    if problems:
        sys.exit(1)


def manifest(uri):
    out = {"engine": "milvus", "seed": "docker/milvus/seed.py", "server_version": connect(uri).get_server_version(),
           "databases": {}}
    for spec in COLLECTIONS:
        out["databases"].setdefault(spec.db, {})[spec.name] = spec.manifest()
    print(json.dumps(out, indent=1, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--uri", required=True)
    parser.add_argument("--credentials")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--verify", action="store_true")
    mode.add_argument("--manifest", action="store_true")
    args = parser.parse_args()
    if args.manifest:
        manifest(args.uri)
    elif args.verify:
        verify(args.uri)
    elif args.credentials is None:
        parser.error("--credentials DIR is required to seed")
    else:
        seed(args.uri, args.credentials)


if __name__ == "__main__":
    main()
