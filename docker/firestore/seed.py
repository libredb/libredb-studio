#!/usr/bin/env python3
"""Write the Firestore sample data of docker/firestore/seed.json into an emulator.

One :commit request carries every document as an update with its full resource name in
the body, so no id reaches a URL path: the emulator reads a `:` in the last path segment
as the start of a verb. Running it again rewrites the same documents. Standard library only.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the Firestore emulator with docker/firestore/seed.json.")
    parser.add_argument("--host", required=True, help="host:port of the emulator, such as firestore:8080")
    parser.add_argument("--seed", default="/seed/seed.json", help="the seed file")
    args = parser.parse_args()
    with open(args.seed, encoding="utf-8") as handle:
        seed = json.load(handle)
    root = f"projects/{seed['project']}/databases/(default)/documents"
    writes = [{"update": {"name": f"{root}/{doc['path']}", "fields": doc["fields"]}} for doc in seed["documents"]]
    body = json.dumps({"writes": writes}).encode("utf-8")
    url = f"http://{args.host}/v1/{root}:commit"
    headers = {"content-type": "application/json", "authorization": "Bearer owner"}
    for _ in range(30):
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=10):
                print(f"seeded {len(writes)} documents into {seed['project']}", file=sys.stderr)
                return 0
        except urllib.error.HTTPError as error:
            print(f"the emulator refused the seed: {error.code} {error.read().decode('utf-8', 'replace')}", file=sys.stderr)
            return 1
        except urllib.error.URLError:
            time.sleep(1)
    print(f"the emulator at {args.host} did not answer within 30 attempts", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
