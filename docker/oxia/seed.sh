#!/bin/sh
# Seeds one Oxia fixture through the Oxia CLI, from inside the Oxia image, so no other client
# and no Node package is involved.
#   seed.sh <host:port> <full|small|blind>
# full is the default server's key space, small and blind the two natural-order servers'.
# Each set wipes the namespace first, so the script may run again on a seeded server, and
# writes the marker /libredb-fixture/seeded last, with the set's name as its value, so a
# reader that finds the marker knows every other key is there.
# Keys the CLI cannot write (U+0000 cannot pass through an argument) and the 20,000 bulk keys
# are added by tests/live/oxia-seed-raw.ts. README.md lists every key and its writer.
# No seeded value reaches the server's 64 MiB WAL segment: the largest is 17 MiB.
set -eu
TARGET=${1:?host:port}
SET=${2:?full, small or blind}

ox() { oxia client -a "$TARGET" --request-timeout 60s "$@" >/dev/null; }
# `--` ends the flags before every key: the CLI reads a key such as -dash as its flag -d
# (measured on 0.16.10).
put() { ox put -- "$1" "$2"; }                 # put KEY VALUE
put_empty() { ox put -- "$1" ''; }             # put_empty KEY
put_stdin() { ox put -c -- "$1"; }             # ... | put_stdin KEY
put_p() { ox put -p "$1" -- "$2" "$3"; }       # put_p PARTITION KEY VALUE
pattern() { head -c "$1" /dev/zero | tr '\0' 'x'; }   # pattern BYTES
wipe() { ox delete-range -s '' -e "$1"; }      # wipe UPPER_BOUND

seed_full() {
  # Under the hierarchical order a key with more `/` than any stored key sorts above every
  # key, so this bound covers the namespace; an empty upper bound deletes nothing.
  wipe "$(printf '/%.0s' $(seq 1 201))~"

  # A Pulsar metadata subtree, with the empty parent keys OxiaMetadataStore.createParents writes.
  put_empty '/admin'
  put_empty '/admin/policies'
  put '/admin/policies/public' '{"adminRoles":[],"allowedClusters":["standalone"]}'
  put '/admin/policies/public/default' '{"bundles":{"boundaries":["0x00000000","0xffffffff"],"numBundles":1}}'
  put_empty '/admin/clusters'
  put '/admin/clusters/standalone' '{"serviceUrl":"http://broker-1:8080","brokerServiceUrl":"pulsar://broker-1:6650"}'
  put_empty '/admin/partitioned-topics'
  put_empty '/admin/partitioned-topics/public'
  put_empty '/admin/partitioned-topics/public/default'
  put_empty '/admin/partitioned-topics/public/default/persistent'
  put '/admin/partitioned-topics/public/default/persistent/orders' '{"partitions":3}'
  put_empty '/managed-ledgers'
  put_empty '/managed-ledgers/public'
  put_empty '/managed-ledgers/public/default'
  put_empty '/managed-ledgers/public/default/persistent'
  # Managed-ledger info is a protobuf message in Pulsar: bytes, not text.
  printf '\010\217\001\022\004\010\001\020\002' | put_stdin '/managed-ledgers/public/default/persistent/orders-partition-0'
  printf '\010\220\001\022\004\010\002\020\002' | put_stdin '/managed-ledgers/public/default/persistent/orders-partition-1'
  printf '\010\221\001\022\004\010\003\020\002' | put_stdin '/managed-ledgers/public/default/persistent/orders-partition-2'
  put_empty '/loadbalance'
  put_empty '/loadbalance/brokers'
  put '/loadbalance/brokers/broker-1:8080' '{"webServiceUrl":"http://broker-1:8080","pulsarServiceUrl":"pulsar://broker-1:6650"}'
  put_empty '/ledgers'
  printf '1\norg.apache.bookkeeper.meta.HierarchicalLedgerManagerFactory:1' | put_stdin '/ledgers/LAYOUT'
  put_empty '/ledgers/available'
  put_empty '/ledgers/available/bookie-1:3181'
  put_empty '/schemas'
  put_empty '/schemas/public'
  put_empty '/schemas/public/default'
  put '/schemas/public/default/orders' '{"type":"AVRO","schema":"{\"type\":\"record\",\"name\":\"Order\",\"fields\":[]}"}'

  # A subtree with no parent keys at all.
  put '/orphan/a/b/c/leaf-1' 'leaf-1'
  put '/orphan/a/b/c/leaf-2' 'leaf-2'
  put '/orphan/x/y' 'y'

  # Ordering probes, each holding its own key, and keys ending in //.
  for i in /a /a/b /a/b/c /a/bb /a/b/ /a/c /ab /b /b/c /a/b/c/d /z; do put "$i" "$i"; done
  for i in /trail// /trail/x// /odd//; do put "$i" "$i"; done

  # Keys with no / at all.
  put 'config' 'a flat key'
  put 'feature-flag.dark-mode' 'true'
  put 'user:42' '{"id":42,"name":"Ada"}'
  put 'zz-last-flat' 'x'

  # Keys an argument can carry that a reader must still show byte for byte.
  put '/odd/with space' 'a space'
  put '/odd/100%' 'a percent sign'
  put "$(printf '/odd/tab\tkey')" 'a tab'
  put '/odd/"quoted"' 'double quotes'
  put '/odd/back\slash' 'a backslash'
  put "$(printf '/odd/emoji-\360\237\231\202')" 'U+1F642'
  put "$(printf '/odd/max-\364\217\277\277')" 'U+10FFFF'
  put "/odd/long/$(pattern 4000 | tr x k)" 'a 4,010-byte key'

  # One value of each kind a reader classifies.
  put '/values/json' '{"name":"oxia","nested":{"list":[1,2,3],"ok":true,"nil":null}}'
  put '/values/json-int64' '{"id":9007199254740993}'
  put '/values/text-utf8' 'Merhaba dünya, Привет мир, こんにちは'
  printf '\010\001' | put_stdin '/values/text-c0'
  printf '\377\376\000\200' | put_stdin '/values/binary-non-utf8'
  printf '\010\226\001\022\003abc\030\001' | put_stdin '/values/protobuf-like'
  put_empty '/values/empty'
  pattern 102400 | put_stdin '/values/text-100KiB'
  # Two 5 MiB values, so a scan from /values/p to /values/q holds 10 MiB: past a console run's
  # 8 MiB budget, without the 17 MiB value.
  pattern 5242880 | put_stdin '/values/pattern-5MiB'
  pattern 5242880 | put_stdin '/values/pattern-5MiB-b'
  # 17 MiB: above Studio's 16 MiB receive cap, below the server's 64 MiB WAL segment.
  pattern 17825792 | put_stdin '/values/over-cap'

  # Five versions of one key, and three keys routed by the partition key tenant-a.
  for i in 1 2 3 4 5; do put '/versions/counter' "v$i"; done
  for i in 1 2 3; do put_p 'tenant-a' "/pk/tenant-a/$i" "order-$i"; done

  put '/libredb-fixture/seeded' 'full'
}

seed_small() {
  # Under the natural order keys compare by their bytes, and U+10FFFF (f4 8f bf bf) sorts above
  # every key of this set and the blind one.
  wipe "$(printf '\364\217\277\277')"
  for i in /a /a/b /a/b/c /a/bb /a/b/ /a/c /ab /b /b/c /a/b/c/d /z; do put "$i" "$i"; done
  for i in /trail// /trail/x// /odd//; do put "$i" "$i"; done
  put 'config' 'a flat key'
  put 'feature-flag.dark-mode' 'true'
  put 'user:42' '{"id":42,"name":"Ada"}'
  put 'zz-last-flat' 'x'
  # Keys whose first byte sorts below /.
  put '-dash' 'v'
  put '.dot' 'v'
  put '!bang' 'v'
  put '/libredb-fixture/seeded' 'small'
}

seed_blind() {
  wipe "$(printf '\364\217\277\277')"
  # The blind spot of the order probe: every listed key begins with a byte below /. The marker
  # holds / and sorts above them all.
  i=0; while [ "$i" -lt 600 ]; do put "$(printf -- '-k%04d' "$i")" 'v'; i=$((i + 1)); done
  put '-a/b' 'v'
  put '-a/bb' 'v'
  put '-a/c' 'v'
  put '.b/x' 'v'
  put '/libredb-fixture/seeded' 'blind'
}

case "$SET" in
  full) seed_full ;;
  small) seed_small ;;
  blind) seed_blind ;;
  *) echo "seed.sh: the set is full, small or blind, not $SET" >&2; exit 2 ;;
esac
echo "seeded $SET on $TARGET"
