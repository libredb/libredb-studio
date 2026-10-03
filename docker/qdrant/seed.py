#!/usr/bin/env python3
"""Seeds a Qdrant service of database-compose.yml for the vector fixtures (docker/qdrant/README.md).

  seed.py --url URL [--api-key-file FILE]              create what is missing; a second run does no work
  seed.py --url URL [--api-key-file FILE] --verify     read every seeded object back, print a report, exit 1 on a difference
  seed.py --url URL [--api-key-file FILE] --manifest --image IMAGE@DIGEST
                                                       print the manifest of what the seed inserts, as JSON on
                                                       stdout, with the server's pinned image, its digest and the date

Ported from the design research's seed. Every vector and payload value comes from numpy default_rng with fixed
seeds (20261002, 7 and 11 for the research's collections, 20261003 for payload_spread), UUID ids are uuid5 of a
fixed namespace and timestamps are fixed, so every point is byte-identical across servers and resets. Progress goes
to stderr, so --manifest prints nothing but the manifest on stdout.
"""

import argparse
import datetime
import json
import math
import sys
import time
import urllib.request
import uuid

import numpy as np
from qdrant_client import QdrantClient, models

UUID_NS = uuid.UUID("6f1c2a52-6d1e-4c1b-9b9c-000000000000")
TWO_53 = 2**53
TWO_60 = 2**60
# Edge ids: 0, a small id, 2^53 + 1 (the first integer a JS number cannot hold exactly), 2^63 (the first id outside
# signed 64-bit) and 2^64 - 1 (the largest uint64).
EDGE_INT_IDS = [0, 42, TWO_53 + 1, 2**63, 2**64 - 1]
N_UUID = 1000
N_BIG = 1000 - len(EDGE_INT_IDS)
DIM_TEXT = 384
DIM_IMAGE = 64
DIM_COLBERT = 16
SPARSE_VOCAB = 30000
CATEGORIES = ["alpha", "beta", "gamma", "delta", "epsilon"]
TEAMS = ["core", "search", "infra", "ml"]
WORDS = ["vector", "search", "engine", "payload", "filter", "index", "graph", "cosine", "shard", "segment",
         "point", "collection", "alias", "snapshot", "cluster", "replica", "quantize", "sparse", "dense", "recall"]
SPREAD_CATEGORIES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]
SPREAD_WORDS = ["red", "green", "blue", "quick", "lazy", "fox", "dog", "cat", "sun", "moon"]
SAMPLE = 5

COSINE_REASON = "the server normalises a Cosine vector when it is written, so it does not return what the seed sent"
TURBO4_REASON = "turbo4 stores a quantised reconstruction, not the values the seed sent"

COLLECTIONS = ["docs", "small_dtypes", "plain", "scratch", "empty_novec", "edge_values", "payload_spread"]
ALIASES = {"docs_alias": "docs", "plain_alias": "plain"}
POINTS = {"docs": 2000, "small_dtypes": 200, "plain": 300, "scratch": 0, "empty_novec": 0, "edge_values": 3,
          "payload_spread": 20000}
RULES = {
    "docs": "ids above 2^53 and UUIDs side by side, named dense, multivector and sparse vectors, eleven payload indexes",
    "small_dtypes": "the float16, uint8 and turbo4 datatypes, a Manhattan vector and a sparse vector with a uint8 index",
    "plain": "one unnamed vector, the shape of the documentation's own examples",
    "scratch": "the shared writable collection",
    "empty_novec": "a collection with no vector at all",
    "edge_values": "the copy loop's edge rows, a float16 overflow, the non-finite score of a 3.4e38 sparse value",
    "payload_spread": "the payload sample's rules: a type that changes with the id, rare keys, integral floats",
}


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def vector(name, kind, size, distance, datatype, reason=None):
    return {"name": name, "kind": kind, "size": size, "distance": distance, "datatype": datatype,
            "derivable": reason is None, **({"reason": reason} if reason else {})}


VECTORS = {
    "docs": [vector("text", "dense", DIM_TEXT, "Cosine", "float32", COSINE_REASON),
             vector("image", "dense", DIM_IMAGE, "Euclid", "float32"),
             vector("colbert", "multi", DIM_COLBERT, "Dot", "float32"),
             vector("keywords", "sparse", None, None, "float32")],
    "small_dtypes": [vector("f16", "dense", 8, "Cosine", "float16", COSINE_REASON),
                     vector("u8", "dense", 8, "Euclid", "uint8"),
                     vector("t4", "dense", 64, "Cosine", "turbo4", TURBO4_REASON),
                     vector("manhattan", "dense", 4, "Manhattan", "float32"),
                     vector("sp_u8", "sparse", None, None, "uint8")],
    "plain": [vector("", "dense", 4, "Dot", "float32")],
    "scratch": [vector("", "dense", 8, "Cosine", "float32", COSINE_REASON),
                vector("sp", "sparse", None, None, "float32")],
    "empty_novec": [],
    "edge_values": [vector("f16", "dense", 4, "Euclid", "float16"), vector("u8", "dense", 4, "Euclid", "uint8"),
                    vector("f32", "dense", 4, "Euclid", "float32"), vector("multi", "multi", 2, "Dot", "float32"),
                    vector("sp", "sparse", None, None, "float32")],
    "payload_spread": [vector("", "dense", 4, "Dot", "float32")],
}


def finite(value):
    return value if math.isfinite(value) else None


def stored_dense(datatype, values):
    """A dense vector as the server stores it: float16 rounded (an overflow is null), uint8 as floats, else float32."""
    with np.errstate(over="ignore"):
        if datatype == "float16":
            return [finite(float(np.float16(np.float32(item)))) for item in values]
    if datatype == "uint8":
        return [float(int(item)) for item in values]
    return [finite(float(np.float32(item))) for item in values]


def stored_sparse(indices, values):
    pairs = sorted(zip((int(index) for index in indices), values))
    return {"indices": [index for index, _ in pairs], "values": [finite(float(np.float32(item))) for _, item in pairs]}


def unit(rng, n, dim):
    v = rng.standard_normal((n, dim)).astype(np.float32)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    return v


# -- the research's collections -------------------------------------------------------------------------------

def docs_ids():
    ids = list(EDGE_INT_IDS)
    ids += [TWO_60 + n for n in range(N_BIG)]
    ids += [str(uuid.uuid5(UUID_NS, f"doc-{n:04d}")) for n in range(N_UUID)]
    return ids


def docs_data():
    rng = np.random.default_rng(20261002)
    ids = docs_ids()
    n = len(ids)
    text = unit(rng, n, DIM_TEXT)
    image = rng.uniform(-10, 10, (n, DIM_IMAGE)).astype(np.float32)
    colbert = unit(rng, n * 3, DIM_COLBERT)
    points = []
    for seq, pid in enumerate(ids):
        nnz = 5 + seq % 11
        indices = sorted(set(int(x) for x in rng.choice(SPARSE_VOCAB, nnz, replace=False)))
        values = [round(float(x), 4) for x in rng.uniform(0.05, 3.0, len(indices))]
        sub = 1 + seq % 3
        vectors = {"text": text[seq].tolist(), "colbert": colbert[seq * 3: seq * 3 + sub].tolist(),
                   "keywords": (indices, values)}
        if seq % 10 != 9:
            vectors["image"] = image[seq].tolist()
        category = CATEGORIES[seq % len(CATEGORIES)]
        words = [WORDS[(seq * 7 + k) % len(WORDS)] for k in range(4)]
        payload = {
            "seq": seq,
            "id_kind": "uuid" if isinstance(pid, str) else "uint",
            "title": f"Document {seq:04d} {category}",
            "body": " ".join(words) + f" number {seq}",
            "category": category,
            "big_int": TWO_53 + 1 + seq,
            "price": round(float(rng.uniform(1, 1000)), 2),
            "ratio": float(rng.uniform(0, 1)),
            "active": seq % 3 != 0,
            "tags": [category, WORDS[seq % len(WORDS)]] + (["even"] if seq % 2 == 0 else []),
            "scores": [round(float(x), 3) for x in rng.uniform(0, 1, 3)],
            "meta": {
                "source": "libredb-seed",
                "version": 1 + seq % 4,
                "owner": {"name": f"user{seq % 50:02d}", "team": TEAMS[seq % len(TEAMS)]},
                "flags": {"reviewed": seq % 5 == 0, "lang": "en" if seq % 4 else "tr"},
            },
            "items": [{"sku": f"SKU-{seq:04d}-{k}", "qty": k + 1} for k in range(seq % 3)],
            "location": {"lon": round(float(rng.uniform(26, 45)), 6), "lat": round(float(rng.uniform(36, 42)), 6)},
            "created_at": f"2026-{1 + seq % 12:02d}-{1 + seq % 28:02d}T{seq % 24:02d}:{seq % 60:02d}:00.{seq % 1000:03d}Z",
            "ref_uuid": str(uuid.uuid5(UUID_NS, f"ref-{seq}")),
            "mixed": [seq, str(seq), float(seq) + 0.5, seq % 2 == 0, None][seq % 5],
        }
        if seq % 7 == 0:
            payload["maybe"] = None
        if seq % 13 == 0:
            payload["empty_list"] = []
            payload["empty_obj"] = {}
        if seq == 0:
            payload["unicode"] = "Istanbul, İstanbul, şğüöç, 日本語"
        if seq == 1:
            payload["i64_max"] = 2**63 - 1
            payload["i64_min"] = -(2**63)
            payload["float_tiny"] = 5e-324
            payload["float_big"] = 1.7976931348623157e308
        points.append({"seq": seq, "id": pid, "vectors": vectors, "payload": payload})
    return points


def small_dtypes_data():
    rng = np.random.default_rng(7)
    f16 = unit(rng, 200, 8)
    u8 = rng.integers(0, 256, (200, 8))
    t4 = unit(rng, 200, 64)
    manhattan = rng.uniform(-1, 1, (200, 4)).astype(np.float32)
    points = []
    for i in range(200):
        indices = sorted(set(int(x) for x in rng.choice(1000, 6, replace=False)))
        values = [float(x) for x in rng.integers(1, 256, len(indices))]
        points.append({"seq": i, "id": i, "vectors": {
            "f16": f16[i].tolist(), "u8": [int(x) for x in u8[i]], "t4": t4[i].tolist(),
            "manhattan": manhattan[i].tolist(), "sp_u8": (indices, values)},
            "payload": {"i": i, "label": ["north", "south", "east", "west"][i % 4]}})
    return points


def plain_data():
    rng = np.random.default_rng(11)
    values = rng.uniform(-1, 1, (300, 4)).astype(np.float32)
    return [{"seq": i, "id": i + 1, "vectors": {"": values[i].tolist()},
             "payload": {"n": i + 1, "city": ["Berlin", "London", "Ankara"][i % 3]}} for i in range(300)]


# -- the collections this repository adds ---------------------------------------------------------------------

EDGE_POINTS = [
    (1, "range-ends", {"f16": [65504.0, -65504.0, 6.103515625e-05, 5.960464477539063e-08], "u8": [0, 255, 128, 1],
                       "f32": [3.4028234663852886e38, 1.401298464324817e-45, 1.1754943508222875e-38, 0.1],
                       "multi": [[1.0, 2.0], [3.0, 4.0]], "sp": ([0, 4294967295], [1e-30, 0.5])}),
    (2, "non-finite-score", {"f16": [70000.0, 1.0, 2.0, 3.0], "u8": [1, 2, 3, 4],
                             "f32": [16777217.0, 0.333333343267, 2.5, -7.0],
                             "multi": [[0.1, 0.2]], "sp": ([7], [3.4e38])}),
    (3, "metric-probe", {"f16": [3.0, 4.0, 0.0, 0.0], "u8": [3, 4, 0, 0], "f32": [3.0, 4.0, 0.0, 0.0],
                         "multi": [[3.0, 4.0]], "sp": ([2], [1.0])}),
]


def edge_values_data():
    return [{"seq": seq, "id": pid, "vectors": vectors, "payload": {"label": label}}
            for seq, (pid, label, vectors) in enumerate(EDGE_POINTS)]


def spread_data():
    rng = np.random.default_rng(20261003)
    values = rng.uniform(-1, 1, (20000, 4)).astype(np.float32)
    points = []
    for seq in range(20000):
        payload = {
            "seq": seq,
            "sku": f"sku-{seq:06d}",
            "category": SPREAD_CATEGORIES[seq % 8],
            # A float field whose every fourth value is integral and written as JavaScript writes one: 12, not 12.0.
            "price": int(rng.integers(0, 100)) if seq % 4 == 0 else round(float(rng.uniform(0, 100)), 2),
            "active": seq % 2 == 0,
            # An integer on the first 10,000 ids and a string after them, so a contiguous sample misses the change.
            "variant": seq if seq < 10000 else f"v{seq}",
            "mixed": [seq, f"s{seq}", seq + 0.5, seq % 2 == 0, None][seq % 5],
            f"attr_{seq % 50}": SPREAD_WORDS[seq % 10],
        }
        if seq % 100 == 7:
            payload["legacy_code"] = f"L{seq}"
        if seq % 1000 == 11:
            payload["rare_flag"] = True
        points.append({"seq": seq, "id": seq, "vectors": {"": values[seq].tolist()}, "payload": payload})
    return points


DATA = {"docs": docs_data, "small_dtypes": small_dtypes_data, "plain": plain_data, "scratch": lambda: [],
        "empty_novec": lambda: [], "edge_values": edge_values_data, "payload_spread": spread_data}


def wire_vectors(collection, vectors):
    out = {}
    for name, value in vectors.items():
        out[name] = models.SparseVector(indices=value[0], values=value[1]) if isinstance(value, tuple) else value
    return out.get("") if list(out) == [""] else out


def create(c, name):
    params = {}
    sparse = {}
    for v in VECTORS[name]:
        if v["kind"] == "sparse":
            index = models.SparseIndexParams(datatype=models.Datatype.UINT8) if v["datatype"] == "uint8" else None
            modifier = models.Modifier.IDF if (name, v["name"]) == ("docs", "keywords") else None
            sparse[v["name"]] = models.SparseVectorParams(index=index, modifier=modifier)
            continue
        datatype = None if v["datatype"] == "float32" else models.Datatype(v["datatype"])
        multivector = (models.MultiVectorConfig(comparator=models.MultiVectorComparator.MAX_SIM)
                       if v["kind"] == "multi" else None)
        params[v["name"]] = models.VectorParams(size=v["size"], distance=models.Distance(v["distance"]),
                                                datatype=datatype, multivector_config=multivector)
    vectors_config = params.get("") if list(params) == [""] else params
    c.create_collection(collection_name=name, vectors_config=vectors_config or None,
                        sparse_vectors_config=sparse or None)
    if name == "docs":
        for field, schema in [
            ("seq", models.PayloadSchemaType.INTEGER), ("category", models.PayloadSchemaType.KEYWORD),
            ("big_int", models.PayloadSchemaType.INTEGER), ("price", models.PayloadSchemaType.FLOAT),
            ("active", models.PayloadSchemaType.BOOL), ("location", models.PayloadSchemaType.GEO),
            ("created_at", models.PayloadSchemaType.DATETIME), ("body", models.PayloadSchemaType.TEXT),
            ("ref_uuid", models.PayloadSchemaType.UUID), ("meta.owner.team", models.PayloadSchemaType.KEYWORD),
            ("tags", models.PayloadSchemaType.KEYWORD),
        ]:
            c.create_payload_index(name, field_name=field, field_schema=schema, wait=True)
    points = [models.PointStruct(id=point["id"], vector=wire_vectors(name, point["vectors"]), payload=point["payload"])
              for point in DATA[name]()]
    for start in range(0, len(points), 250):
        c.upsert(name, points=points[start:start + 250], wait=True)


def connect(url, api_key):
    return QdrantClient(url=url, api_key=api_key, https=url.startswith("https://"), prefer_grpc=False, timeout=120,
                        check_compatibility=False)


def server_version(url, api_key):
    request = urllib.request.Request(url.rstrip("/") + "/", headers={"api-key": api_key} if api_key else {})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["version"]


def seed(c):
    existing = {collection.name for collection in c.get_collections().collections}
    for name in COLLECTIONS:
        if name in existing:
            log(f"{name} exists, kept")
            continue
        started = time.time()
        create(c, name)
        log(f"{name} created in {time.time() - started:.1f} s")
    aliases = {alias.alias_name: alias.collection_name for alias in c.get_aliases().aliases}
    for alias, target in ALIASES.items():
        if alias in aliases and aliases[alias] != target:
            sys.exit(f"the alias {alias} points at {aliases[alias]}, not {target}: remove the container to start over")
    missing = [alias for alias in ALIASES if alias not in aliases]
    if missing:
        c.update_collection_aliases(change_aliases_operations=[
            models.CreateAliasOperation(create_alias=models.CreateAlias(collection_name=ALIASES[alias], alias_name=alias))
            for alias in missing])
        log(f"aliases {', '.join(missing)} created")
    log("seed finished")


def verify(c, url, api_key):
    problems = []
    report = {"server_version": server_version(url, api_key), "collections": {}}
    existing = {collection.name for collection in c.get_collections().collections}
    for name in COLLECTIONS:
        if name not in existing:
            problems.append(f"{name} is missing")
            continue
        count = c.count(name, exact=True).count
        if count != POINTS[name]:
            problems.append(f"{name} holds {count} points, not {POINTS[name]}")
        report["collections"][name] = {"points": count}
    aliases = {alias.alias_name: alias.collection_name for alias in c.get_aliases().aliases}
    problems.extend(f"the alias {alias} points at {aliases.get(alias)}, not {target}"
                    for alias, target in ALIASES.items() if aliases.get(alias) != target)
    if "docs" in existing:
        found = {str(point.id) for point in c.retrieve("docs", ids=EDGE_INT_IDS)}
        problems.extend(f"docs lacks the edge id {pid}" for pid in EDGE_INT_IDS if str(pid) not in found)
    report["problems"] = problems
    print(json.dumps(report, indent=1, sort_keys=True))
    if problems:
        sys.exit(1)


def json_type(value):
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "float"
    if value is None:
        return "null"
    return {str: "string", list: "array", dict: "object"}[type(value)]


def payload_keys(points):
    keys = {}
    for point in points:
        for key, value in point["payload"].items():
            entry = keys.setdefault(key, {"points": 0, "types": set()})
            entry["points"] += 1
            entry["types"].add(json_type(value))
    return {key: {"points": entry["points"], "types": sorted(entry["types"])} for key, entry in sorted(keys.items())}


def stored_vectors(name, vectors):
    out = {}
    for v in VECTORS[name]:
        if not v["derivable"]:
            continue
        value = vectors.get(v["name"])
        if value is None:
            out[v["name"]] = None
        elif v["kind"] == "sparse":
            out[v["name"]] = stored_sparse(*value)
        elif v["kind"] == "multi":
            out[v["name"]] = [stored_dense(v["datatype"], row) for row in value]
        else:
            out[v["name"]] = stored_dense(v["datatype"], value)
    return out


def pinned_build(reference):
    """The image and digest of the server's pinned reference IMAGE@DIGEST, with the date the manifest is printed."""
    image, _, digest = reference.partition("@")
    if not digest.startswith("sha256:"):
        sys.exit(f"--image {reference} is not pinned by digest")
    now = datetime.datetime.now(datetime.timezone.utc)
    return {"image": image, "digest": digest, "date": now.isoformat(timespec="milliseconds").replace("+00:00", "Z")}


def manifest(url, api_key, reference):
    collections = {}
    for name in COLLECTIONS:
        points = DATA[name]()
        size = len(points) if name == "edge_values" else (0 if name == "payload_spread" else SAMPLE)
        entry = {
            "rule": RULES[name],
            "points": len(points),
            "aliases": sorted(alias for alias, target in ALIASES.items() if target == name),
            "vectors": VECTORS[name],
            "key": "id",
            "sample": [{"seq": point["seq"], "id": point["id"], "vectors": stored_vectors(name, point["vectors"])}
                       for point in points[:size]],
        }
        if name == "payload_spread":
            entry["payload_keys"] = payload_keys(points)
        collections[name] = entry
    print(json.dumps({"engine": "qdrant", "seed": "docker/qdrant/seed.py",
                      "server_version": server_version(url, api_key), **pinned_build(reference),
                      "collections": collections},
                     indent=1, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True)
    parser.add_argument("--api-key-file")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--verify", action="store_true")
    mode.add_argument("--manifest", action="store_true")
    parser.add_argument("--image", help="the server's pinned reference IMAGE@DIGEST, which --manifest records")
    args = parser.parse_args()
    if args.manifest and args.image is None:
        parser.error("--image IMAGE@DIGEST is required with --manifest")
    api_key = None
    if args.api_key_file:
        with open(args.api_key_file, encoding="utf-8") as file:
            api_key = file.read().strip()
    if args.manifest:
        manifest(args.url, api_key, args.image)
        return
    c = connect(args.url, api_key)
    if args.verify:
        verify(c, args.url, api_key)
    else:
        seed(c)


if __name__ == "__main__":
    main()
