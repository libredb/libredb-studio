#!/bin/sh
# Turns etcd RBAC on with the users and roles the auth fixtures need, after seed.sh.
#   rbac.sh <client URL>        for example https://etcd-auth:2379
# Auth is turned on last, so a server with auth on already holds every user, role and grant
# below, and the script then stops: granting again would answer without an error but move the
# auth revision, which invalidates every token issued before it (measured on 3.7.2). A first
# run that failed part way leaves auth off and simply runs again. The passwords are the ones
# certs.sh generated.
#   root       the root role; password root.password, or the certificate root.crt
#   reader     role reader; password reader.password, or the certificate reader.crt
#   cert-only  role reader and no password: only the certificate cert-only.crt signs in
# Role reader may READ the prefix /app/ and the single key /config/a, and nothing else, so the
# walk of a user who is not root meets a group it reads whole (/app/a/*), a group it reads one
# key of (/config/* holds /config/a and /config/b), and refusals everywhere else.
ETCD_URL="$1"
. "$(dirname "$0")/lib.sh"
if auth_enabled; then
  echo "auth already enabled on $ETCD_URL"
  exit 0
fi

call /v3/auth/user/add "{\"name\":\"root\",\"password\":\"$(cat "$ETCD_PASSWORD_DIR/root.password")\"}" "user name already exists"
call /v3/auth/user/grant '{"user":"root","role":"root"}'

call /v3/auth/role/add '{"name":"reader"}' "role name already exists"
call /v3/auth/role/grant "{\"name\":\"reader\",\"perm\":{\"permType\":\"READ\",\"key\":\"$(text /app/)\",\"range_end\":\"$(text /app0)\"}}"
call /v3/auth/role/grant "{\"name\":\"reader\",\"perm\":{\"permType\":\"READ\",\"key\":\"$(text /config/a)\"}}"

call /v3/auth/user/add "{\"name\":\"reader\",\"password\":\"$(cat "$ETCD_PASSWORD_DIR/reader.password")\"}" "user name already exists"
call /v3/auth/user/grant '{"user":"reader","role":"reader"}'
call /v3/auth/user/add '{"name":"cert-only","options":{"no_password":true}}' "user name already exists"
call /v3/auth/user/grant '{"user":"cert-only","role":"reader"}'

call /v3/auth/enable '{}'
echo "auth enabled on $ETCD_URL"
