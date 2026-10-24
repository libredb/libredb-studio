#!/usr/bin/env python3
"""Seeds a Weaviate service of database-compose.yml for the vector fixtures (docker/weaviate/README.md).

  seed.py --url URL [--api-key-file FILE] [--cacert FILE] [--reader-key-out FILE]
                                                    create what is missing; a second run does no work
  seed.py --url URL [--api-key-file FILE] [--cacert FILE] --verify
                                                    read every seeded collection back, print a report, exit 1 on a difference

--reader-key-out, on an RBAC server, also creates db user reader with the built-in viewer role and writes its key to
FILE; a user that exists while FILE does not has its key rotated, since the server shows a key only once.

Standard library only, so the seed installs nothing. Every vector comes from random.Random with a fixed seed per
collection, ids are uuid5 of a fixed namespace and dates are fixed, so every object is byte-identical across servers
and resets. The same corpus seeds every version of the matrix, from the 1.37 line up, so it uses only schema fields
that line accepts. Progress goes to stderr.
"""

import argparse
import json
import os
import random
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid

UUID_NS = uuid.UUID("3d1b7a40-5b0e-4f7e-9a51-000000000000")
TWO_53 = 2**53
# 2^53 - 1 is the largest integer a JS number holds exactly, 2^53 + 1 the first it cannot; then the int64 bounds.
EDGE_INTS = [0, 42, -42, TWO_53 - 1, TWO_53 + 1, 2**62 + 7, 2**63 - 1, -(2**63)]
DIM_ARTICLE = 16
DIM_IMAGE = 8
DIM_TEXT = 16
N_ARTICLE = 500
N_AUTHOR = 12
N_PRODUCT = 200
N_NOTES = 20
DATE = "2026-10-01T12:00:00Z"
CATEGORIES = ["alpha", "beta", "gamma", "delta", "epsilon"]
WORDS = ["vector", "search", "engine", "filter", "index", "graph", "cosine", "shard", "tenant", "alias",
         "collection", "replica", "quantize", "hybrid", "keyword", "recall", "object", "property", "schema", "node"]

# Tenant activity is set after the data is written, so a COLD tenant holds objects a read could try to wake.
TENANTS = {
    "TenantNotes": {"acme": "HOT", "globex": "HOT", "initech": "COLD"},
    "TenantNotesAuto": {"umbrella": "COLD", "hooli": "HOT"},
}
ALIASES = {"Articles": "Article"}

SCHEMA = [
    {
        "class": "Author",
        "description": "objects with no vector at all",
        "vectorizer": "none",
        "properties": [
            {"name": "name", "dataType": ["text"]},
            {"name": "country", "dataType": ["text"], "tokenization": "field"},
        ],
    },
    {
        "class": "Article",
        "description": "one unnamed vector, a cross-reference and the common property types",
        "vectorizer": "none",
        "vectorIndexConfig": {"distance": "cosine"},
        "invertedIndexConfig": {"indexTimestamps": True},
        "properties": [
            {"name": "title", "dataType": ["text"]},
            {"name": "body", "dataType": ["text"]},
            {"name": "category", "dataType": ["text"], "tokenization": "field"},
            {"name": "tags", "dataType": ["text[]"]},
            {"name": "wordCount", "dataType": ["int"]},
            {"name": "rating", "dataType": ["number"]},
            {"name": "published", "dataType": ["boolean"]},
            {"name": "publishedAt", "dataType": ["date"]},
            {"name": "location", "dataType": ["geoCoordinates"]},
            {"name": "meta", "dataType": ["object"], "nestedProperties": [
                {"name": "source", "dataType": ["text"]},
                {"name": "revision", "dataType": ["int"]},
            ]},
            {"name": "writtenBy", "dataType": ["Author"]},
        ],
    },
    {
        "class": "Product",
        "description": "two named vectors with different dimensions and distances",
        "vectorConfig": {
            "image": {"vectorizer": {"none": {}}, "vectorIndexType": "hnsw",
                      "vectorIndexConfig": {"distance": "cosine"}},
            "text": {"vectorizer": {"none": {}}, "vectorIndexType": "flat",
                     "vectorIndexConfig": {"distance": "dot"}},
        },
        "properties": [
            {"name": "name", "dataType": ["text"]},
            {"name": "price", "dataType": ["number"]},
            {"name": "sku", "dataType": ["uuid"]},
        ],
    },
    {
        "class": "TenantNotes",
        "description": "multi-tenant, a read does not activate a tenant",
        "vectorizer": "none",
        "multiTenancyConfig": {"enabled": True, "autoTenantCreation": False, "autoTenantActivation": False},
        "properties": [{"name": "note", "dataType": ["text"]}, {"name": "seq", "dataType": ["int"]}],
    },
    {
        "class": "TenantNotesAuto",
        "description": "multi-tenant with autoTenantActivation on",
        "vectorizer": "none",
        "multiTenancyConfig": {"enabled": True, "autoTenantCreation": False, "autoTenantActivation": True},
        "properties": [{"name": "note", "dataType": ["text"]}, {"name": "seq", "dataType": ["int"]}],
    },
    {
        "class": "EdgeValues",
        "description": "int64 values a float64 cannot hold, one object per value",
        "vectorizer": "none",
        "properties": [
            {"name": "label", "dataType": ["text"]},
            {"name": "big", "dataType": ["int"]},
            {"name": "bigs", "dataType": ["int[]"]},
        ],
    },
    {"class": "Empty", "description": "no objects", "vectorizer": "none",
     "properties": [{"name": "label", "dataType": ["text"]}]},
]


def oid(collection, n, tenant=""):
    return str(uuid.uuid5(UUID_NS, f"{collection}/{tenant}/{n}"))


def vec(rng, dim):
    return [round(rng.uniform(-1, 1), 6) for _ in range(dim)]


def words(rng, n):
    return " ".join(rng.choice(WORDS) for _ in range(n))


class Client:
    def __init__(self, url, api_key, cacert=None):
        self.url = url.rstrip("/")
        self.headers = {"Content-Type": "application/json"}
        if api_key:
            self.headers["Authorization"] = f"Bearer {api_key}"
        self.context = ssl.create_default_context(cafile=cacert) if cacert else None

    def call(self, method, path, body=None, ok=(200,)):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=self.headers)
        try:
            with urllib.request.urlopen(req, timeout=60, context=self.context) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as err:
            status, raw = err.code, err.read()
        if status not in ok:
            raise RuntimeError(f"{method} {path}: HTTP {status}: {raw[:400].decode(errors='replace')}")
        return status, (json.loads(raw) if raw.strip() else None)

    def wait_ready(self, seconds=120):
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                if self.call("GET", "/v1/.well-known/ready", ok=(200, 503))[0] == 200:
                    return
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(1)
        raise RuntimeError(f"{self.url} not ready after {seconds}s")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def article_objects():
    rng = random.Random(20261023)
    out = []
    for i in range(N_ARTICLE):
        props = {
            "title": f"article {i:03d} {words(rng, 2)}",
            "body": words(rng, 12),
            "category": CATEGORIES[i % len(CATEGORIES)],
            "tags": sorted({rng.choice(WORDS) for _ in range(3)}),
            "wordCount": 100 + i,
            "rating": round(i / 100, 2),
            "published": i % 3 != 0,
            "publishedAt": DATE,
            "location": {"latitude": 59.437 + i / 1000, "longitude": 24.7536},
            "meta": {"source": "seed", "revision": i % 4},
            "writtenBy": [{"beacon": f"weaviate://localhost/Author/{oid('Author', i % N_AUTHOR)}"}],
        }
        out.append({"class": "Article", "id": oid("Article", i), "properties": props, "vector": vec(rng, DIM_ARTICLE)})
    return out


def author_objects():
    return [{"class": "Author", "id": oid("Author", i),
             "properties": {"name": f"author {i:02d}", "country": ["EE", "TR", "DE", "BR"][i % 4]}}
            for i in range(N_AUTHOR)]


def product_objects():
    rng = random.Random(7)
    return [{"class": "Product", "id": oid("Product", i),
             "properties": {"name": f"product {i:03d}", "price": round(1 + i * 0.25, 2),
                            "sku": str(uuid.uuid5(UUID_NS, f"sku/{i}"))},
             "vectors": {"image": vec(rng, DIM_IMAGE), "text": vec(rng, DIM_TEXT)}}
            for i in range(N_PRODUCT)]


def note_objects(collection):
    out = []
    for tenant in TENANTS[collection]:
        for i in range(N_NOTES):
            out.append({"class": collection, "tenant": tenant, "id": oid(collection, i, tenant),
                        "properties": {"note": f"{tenant} note {i:02d}", "seq": i}})
    return out


def edge_objects():
    return [{"class": "EdgeValues", "id": oid("EdgeValues", i),
             "properties": {"label": str(v), "big": v, "bigs": [v, 1]}}
            for i, v in enumerate(EDGE_INTS)]


def batch(client, objects, size=100):
    for start in range(0, len(objects), size):
        _, result = client.call("POST", "/v1/batch/objects", {"objects": objects[start:start + size]})
        # A batch answers 200 with per-object errors, so each result is read.
        errors = [r["result"]["errors"] for r in result if r.get("result", {}).get("errors")]
        if errors:
            raise RuntimeError(f"batch errors: {json.dumps(errors[:3])}")


def seed(client):
    _, schema = client.call("GET", "/v1/schema")
    existing = {c["class"] for c in schema.get("classes") or []}
    created = []
    for cls in SCHEMA:
        if cls["class"] not in existing:
            client.call("POST", "/v1/schema", cls)
            created.append(cls["class"])
    log(f"collections created: {created or 'none'}")

    for collection, tenants in TENANTS.items():
        _, have = client.call("GET", f"/v1/schema/{collection}/tenants")
        missing = [{"name": t, "activityStatus": "HOT"} for t in tenants if t not in {x["name"] for x in have}]
        if missing:
            client.call("POST", f"/v1/schema/{collection}/tenants", missing)

    _, aliases = client.call("GET", "/v1/aliases")
    have_aliases = {a["alias"] for a in aliases.get("aliases") or []}
    for alias, target in ALIASES.items():
        if alias not in have_aliases:
            client.call("POST", "/v1/aliases", {"alias": alias, "class": target})

    if "Article" in created:
        batch(client, author_objects())
        batch(client, article_objects())
    if "Product" in created:
        batch(client, product_objects())
    for collection in TENANTS:
        if collection in created:
            batch(client, note_objects(collection))
    if "EdgeValues" in created:
        batch(client, edge_objects())

    # Cold last: a COLD tenant cannot be written, and the objects must exist before it goes cold.
    for collection, tenants in TENANTS.items():
        cold = [{"name": t, "activityStatus": s} for t, s in tenants.items() if s != "HOT"]
        if cold:
            client.call("PUT", f"/v1/schema/{collection}/tenants", cold)
    log("seed done")


def ensure_reader(client, key_out):
    status, _ = client.call("GET", "/v1/users/db/reader", ok=(200, 404))
    if status == 200 and os.path.exists(key_out):
        log("user reader exists")
        return
    if status == 404:
        _, created = client.call("POST", "/v1/users/db/reader", ok=(201,))
    else:
        _, created = client.call("POST", "/v1/users/db/reader/rotate-key")
    client.call("POST", "/v1/authz/users/reader/assign", {"roles": ["viewer"], "userType": "db"})
    with open(key_out, "w") as f:
        f.write(created["apikey"])
    os.chmod(key_out, 0o644)
    log(f"user reader (viewer) key written to {key_out}")


def count(client, collection, tenant=None):
    q = f"/v1/objects?class={collection}&limit=100" + (f"&tenant={tenant}" if tenant else "")
    total, after = 0, None
    while True:
        _, page = client.call("GET", q + (f"&after={after}" if after else ""))
        objs = page.get("objects") or []
        total += len(objs)
        if len(objs) < 100:
            return total
        after = objs[-1]["id"]


def verify(client):
    diffs = []
    expect = {"Article": N_ARTICLE, "Author": N_AUTHOR, "Product": N_PRODUCT, "EdgeValues": len(EDGE_INTS), "Empty": 0}
    for collection, n in expect.items():
        got = count(client, collection)
        print(f"{collection}: {got} objects")
        if got != n:
            diffs.append(f"{collection}: expected {n}, got {got}")
    for collection, tenants in TENANTS.items():
        _, have = client.call("GET", f"/v1/schema/{collection}/tenants")
        status = {t["name"]: t["activityStatus"] for t in have}
        print(f"{collection} tenants: {json.dumps(status, sort_keys=True)}")
        for t, s in tenants.items():
            if status.get(t) != s:
                diffs.append(f"{collection}/{t}: expected {s}, got {status.get(t)}")
            if s == "HOT":
                got = count(client, collection, t)
                if got != N_NOTES:
                    diffs.append(f"{collection}/{t}: expected {N_NOTES} objects, got {got}")
    _, aliases = client.call("GET", "/v1/aliases")
    got_aliases = {a["alias"]: a["class"] for a in aliases.get("aliases") or []}
    print(f"aliases: {json.dumps(got_aliases, sort_keys=True)}")
    if got_aliases != ALIASES:
        diffs.append(f"aliases: expected {ALIASES}, got {got_aliases}")
    for d in diffs:
        print(f"DIFF {d}")
    return 1 if diffs else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True)
    ap.add_argument("--api-key-file")
    ap.add_argument("--cacert")
    ap.add_argument("--reader-key-out")
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()
    api_key = open(args.api_key_file).read().strip() if args.api_key_file else None
    client = Client(args.url, api_key, args.cacert)
    client.wait_ready()
    if args.verify:
        sys.exit(verify(client))
    seed(client)
    if args.reader_key_out:
        ensure_reader(client, args.reader_key_out)


if __name__ == "__main__":
    main()
