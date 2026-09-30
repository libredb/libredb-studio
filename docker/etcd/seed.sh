#!/bin/sh
# Seeds the key space every etcd provider test, capture and live check relies on.
#   seed.sh <client URL>        for example http://etcd:2379
# Idempotent: every key is written only if absent and every lease has a fixed id, so a second
# run against a seeded server changes nothing (not even the revision). With auth on it signs in
# as root first (lib.sh). The keys are listed, with what each exists for, in README.md.
ETCD_URL="$1"
. "$(dirname "$0")/lib.sh"
login_if_auth_enabled

new() { put_new "$(text "$1")" "$(text "$2")"; }
# An encryption-at-rest value: the provider and key name, then 32 fixed bytes of "ciphertext".
encrypted() { { printf 'k8s:enc:aescbc:v1:key1:'; printf %s 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f | xxd -r -p; } | b64; }

# Application-shaped keys, in the layouts of the engines that keep their configuration in
# etcd: an APISIX route and consumer as JSON beside the flat /apisix/plugins, a Patroni leader
# as text, a CoreDNS (SkyDNS) record as JSON.
new /apisix/routes/1 '{"uri":"/hello","upstream":{"type":"roundrobin","nodes":{"127.0.0.1:1980":1}}}'
new /apisix/consumers/jack '{"username":"jack","plugins":{"limit-count":{"count":2,"time_window":60}}}'
new /apisix/plugins '[{"name":"limit-count"},{"name":"proxy-rewrite"}]'
new /service/batman/leader 'postgresql0'
new /service/batman/config '{"ttl":30,"loop_wait":10,"retry_timeout":10}'
new /skydns/local/example/www '{"host":"10.0.0.10","port":80,"ttl":60}'

# The shapes of the prefix-group rule: one-segment keys with and without the leading /, a
# first segment holding only two-segment keys (/config/*), and one mixing both shapes
# (/app/a/* and /app/x/*, with /app/cfg in no group).
new /feature-flag 'enabled'
new plain 'a key with no leading slash'
new /config/a 'alpha'
new /config/b 'beta'
new /app/cfg '{"mode":"blue"}'
new /app/a/b 'nested'
new /app/x/y 'deeper'

# Values the Source tab and the result grid must not show as text: bytes that are not UTF-8,
# one past the cell bound (300,000 bytes, past Kafka's 64 KiB starting point and past 256 KiB),
# zero bytes, and whitespace only; and a key that is not UTF-8.
put_new "$(text /values/not-utf8)" "$(hex fffe0001c328)"
put_new "$(text /values/large)" "$(head -c 300000 /dev/zero | tr '\0' x | b64)"
put_new "$(text /values/empty)" ""
put_new "$(text /values/whitespace)" "$(printf '  \n\t ' | b64)"
put_new "$(printf '/values/key-\377\376' | b64)" "$(text 'the key is not UTF-8')"

# One key with exactly three revisions, for get --rev and watch --rev.
for version in 0 1 2; do put_at_version "$(text /history/counter)" "$(text $((version + 1)))" "$version"; done

# Two leases with a year's TTL and fixed ids past 2^53, so an id read as a JavaScript number
# loses digits: 0x694d8147df1dc4c8 holds one key, and 0x694d8147df1dc4c9 holds one key beside
# a Kubernetes event key, the lease a `lease revoke` must be refused for.
lease_new 7587863092875085000 31536000
lease_new 7587863092875085001 31536000
put_new "$(text /leases/session-1)" "$(text 'held by lease 694d8147df1dc4c8')" 7587863092875085000
put_new "$(text /leases/session-2)" "$(text 'held by lease 694d8147df1dc4c9')" 7587863092875085001
put_new "$(text /registry/events/default/nginx.1)" "$(text '{"kind":"Event","reason":"Scheduled"}')" 7587863092875085001

# A Kubernetes-shaped subtree, so the write refusals and the withheld values run without a
# cluster. The envelopes are `k8s\0` and a runtime.Unknown whose TypeMeta names the object,
# built by hand; the Secret's data holds the marker libredb-fixture-secret, which no answer
# may carry.
put_new "$(text /registry/pods/default/nginx)" "$(hex 6b3873000a090a0276311203506f6412090a070a056e67696e781a002200)"
put_new "$(text /registry/secrets/default/db-creds)" "$(hex 6b3873000a0c0a027631120653656372657412300a0a0a0864622d637265647312220a0870617373776f726412166c6962726564622d666978747572652d7365637265741a002200)"
put_new "$(text /registry/configmaps/default/encrypted)" "$(encrypted)"
put_new "$(text /registry/cbor.example.com/gadgets/default/g1)" "$(hex d9d9f7a26a61706956657273696f6e7363626f722e6578616d706c652e636f6d2f7631646b696e6466476164676574)"
new /registry/example.com/widgets/default/w1 '{"apiVersion":"example.com/v1","kind":"Widget","metadata":{"name":"w1","namespace":"default"},"spec":{"size":3}}'
new registry/secrets/default/legacy '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"legacy"},"data":{"password":"'"$(text libredb-fixture-secret)"'"}}'

# kube-apiserver's compaction clock, at the root and outside every prefix, with the decimal
# revision it writes there.
new compact_rev_key '7'

# A custom --etcd-prefix stand-in: nothing here is under a protected prefix, so only the
# content rule recognises these two values as a Kubernetes store's.
put_new "$(text /tenant-a/configmaps/default/cm)" "$(hex 6b3873000a0f0a0276311209436f6e6669674d617012140a040a02636d120c0a046d6f64651204626c75651a002200)"
put_new "$(text /tenant-a/configmaps/default/cm-encrypted)" "$(encrypted)"

echo "seeded $ETCD_URL"
