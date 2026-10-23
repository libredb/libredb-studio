#!/usr/bin/env python3
"""Prints the AWS Marketplace change set that adds one released version to the
AMI listing, or the entity id of our product from a `list-entities` answer.

WHY A SCRIPT AND NOT A HEREDOC IN THE WORKFLOW. The first draft built this JSON
inside `run: |` with nested heredocs and `${{ }}` interpolation. That is the
shape that broke four of this repository's own documented commands on 20 October
2026 (an unmatched quote, a Python SyntaxError, a silently empty grep), and a
quoting mistake here would be found by a half-finished submission against a
published listing. A script takes arguments, prints JSON, and can be run on a
laptop with no AWS account at all - which is how it was checked before it ever
ran in CI.

Usage:
  entity:  aws-marketplace-change-set.py entity --entities entities.json
  change:  aws-marketplace-change-set.py change --entity <id> --version 1.0.0 \
             --ami ami-0123 --access-role arn:aws:iam::...:role/...
"""
import argparse
import json
import sys


def entity_id(entities_path, ad="LibreDB"):
    """The entity id of the one product whose name carries `ad`.

    Refuses silence on both ends: no match and several matches are different
    mistakes, and a caller that got "" could not tell them apart.
    """
    with open(entities_path, encoding="utf-8") as f:
        d = json.load(f)
    hit = [e for e in d.get("EntitySummaryList", []) if ad.lower() in (e.get("Name") or "").lower()]
    if not hit:
        raise SystemExit("no AmiProduct entity whose name carries %r was visible to this role" % ad)
    if len(hit) > 1:
        raise SystemExit("several entities carry %r: %s" % (ad, ", ".join(e["EntityId"] for e in hit)))
    return hit[0]["EntityId"]


def change_set(entity, version, ami, access_role, notes=None):
    return [{
        "ChangeType": "AddDeliveryOptions",
        "Entity": {"Type": "AmiProduct@1.0", "Identifier": entity},
        "DetailsDocument": {
            "Version": {
                "VersionTitle": version,
                "ReleaseNotes": notes or ("LibreDB Studio %s. Release notes: "
                                          "https://github.com/libredb/libredb-studio/releases/tag/%s" % (version, version)),
            },
            "DeliveryOptions": [{
                "Details": {
                    "AmiDeliveryOptionDetails": {
                        "AmiSource": {
                            "AmiId": ami,
                            "AccessRoleArn": access_role,
                            "UserName": "ubuntu",
                            "OperatingSystemName": "UBUNTU",
                            "OperatingSystemVersion": "24.04",
                        },
                        "UsageInstructions": (
                            "Open https://<instance public DNS>/ in a browser. The first start "
                            "creates the administrator account from the instance user data; no "
                            "password is shipped in the image."),
                        "RecommendedInstanceType": "t3.medium",
                        "SecurityGroups": [{
                            "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
                            "IpRanges": ["0.0.0.0/0"],
                        }],
                    }
                }
            }],
        },
    }]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    alt = p.add_subparsers(dest="komut", required=True)
    e = alt.add_parser("entity")
    e.add_argument("--entities", required=True)
    e.add_argument("--name", default="LibreDB")
    c = alt.add_parser("change")
    c.add_argument("--entity", required=True)
    c.add_argument("--version", required=True)
    c.add_argument("--ami", required=True)
    c.add_argument("--access-role", required=True)
    c.add_argument("--notes")
    a = p.parse_args(argv)
    if a.komut == "entity":
        print(entity_id(a.entities, a.name))
        return 0
    if not a.ami.startswith("ami-"):
        raise SystemExit("--ami must be an AMI id, got %r" % a.ami)
    print(json.dumps(change_set(a.entity, a.version, a.ami, a.access_role, a.notes)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
