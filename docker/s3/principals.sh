#!/bin/sh
# Users and policies of the S3 fixtures (docker/s3/README.md) on a MinIO-lineage or RustFS server, through mc admin.
#
#   principals.sh <endpoint>
#
# Every step is safe to repeat: `user add` sets the password whether or not the user exists, `policy create`
# replaces the policy, and a policy is attached only when the user does not hold it yet. POSIX sh with no grep,
# because the mc images carry sh but not every one carries grep.
set -eu

ENDPOINT="$1"
: "${S3_ROOT_ACCESS_KEY:?set S3_ROOT_ACCESS_KEY}"
: "${S3_ROOT_SECRET_KEY:?set S3_ROOT_SECRET_KEY}"
export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/.mc}"

fail() {
  echo "principals.sh: $*" >&2
  exit 1
}

# run <what> <mc arguments...>: runs mc, and on failure stops with the client's own message.
run() {
  what="$1"
  shift
  out="$(mc "$@" 2>&1)" || fail "$what: $out"
  printf '%s' "$out"
}

run "mc alias set" alias set fx "$ENDPOINT" "$S3_ROOT_ACCESS_KEY" "$S3_ROOT_SECRET_KEY" >/dev/null

users=0
for pair in "studio-browse Browse123pass!" "studio-scoped Scoped123pass!" "studio-getonly Getonly123pass!"; do
  # shellcheck disable=SC2086 # the pair is two words on purpose
  set -- $pair
  run "mc admin user add $1" admin user add fx "$1" "$2" >/dev/null
  users=$((users + 1))
done

policies=0
for name in studio-browse studio-scoped; do
  run "mc admin policy create $name" admin policy create fx "$name" "/s3/policies/$name.json" >/dev/null
  policies=$((policies + 1))
done

# attach <user> <policy>: attaches only when the policyName field of `user info` (a comma-separated list) does not
# hold the policy yet. It reads that field alone, because the answer also carries the user's own name as accessKey,
# and here the user and policy names match.
attach() {
  info="$(run "mc admin user info $1" admin user info fx "$1" --json)"
  held="$(printf '%s' "$info" | sed -n 's/.*"policyName": *"\([^"]*\)".*/\1/p')"
  case ",$held," in *",$2,"*) return 0 ;; esac
  run "mc admin policy attach $2 to $1" admin policy attach fx "$2" --user "$1" >/dev/null
}

attach studio-browse studio-browse
attach studio-scoped studio-scoped
attach studio-getonly readonly

echo "principals.sh: $users users, $policies policies"
