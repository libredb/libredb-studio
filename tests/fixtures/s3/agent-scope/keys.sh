# Sourced by each run.sh beside it, which sets IMAGE, MC_IMAGE, NAME, NET, SERVER, READY, START, here and repo:
# makes the run's four keys, starts the server (START sets PORT, the S3 port Docker picked on 127.0.0.1), gives the
# three read keys their policies and runs the measurement, S3_SCOPE_LIVE (tests/live/s3-agent-scope.ts by default).
S3_SCOPE_ROOT_KEY="root$(openssl rand -hex 6)"
S3_SCOPE_ROOT_SECRET="$(openssl rand -hex 20)"
S3_SCOPE_SCOPED_KEY="scoped$(openssl rand -hex 6)"
S3_SCOPE_SCOPED_SECRET="$(openssl rand -hex 20)"
S3_SCOPE_BROAD_KEY="broad$(openssl rand -hex 6)"
S3_SCOPE_BROAD_SECRET="$(openssl rand -hex 20)"
S3_SCOPE_UNLISTED_KEY="unlisted$(openssl rand -hex 6)"
S3_SCOPE_UNLISTED_SECRET="$(openssl rand -hex 20)"
export S3_SCOPE_ROOT_KEY S3_SCOPE_ROOT_SECRET S3_SCOPE_SCOPED_KEY S3_SCOPE_SCOPED_SECRET S3_SCOPE_BROAD_KEY \
  S3_SCOPE_BROAD_SECRET S3_SCOPE_UNLISTED_KEY S3_SCOPE_UNLISTED_SECRET

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NET" >/dev/null
# The values reach the container through the environment by name only, so no secret is on a command line.
START
i=0
until curl -fsS -o /dev/null 2>/dev/null "http://127.0.0.1:$PORT$READY"; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "run.sh: $NAME never became ready" >&2; exit 1; }
  sleep 1
done

R="$S3_SCOPE_ROOT_KEY" S="$S3_SCOPE_ROOT_SECRET" SK="$S3_SCOPE_SCOPED_KEY" SS="$S3_SCOPE_SCOPED_SECRET" \
  BK="$S3_SCOPE_BROAD_KEY" BS="$S3_SCOPE_BROAD_SECRET" UK="$S3_SCOPE_UNLISTED_KEY" US="$S3_SCOPE_UNLISTED_SECRET" \
  docker run --rm --network "$NET" -e R -e S -e SK -e SS -e BK -e BS -e UK -e US -e MC_CONFIG_DIR=/tmp/.mc \
  -v "$here/../scoped-policy.json:/scoped.json:ro" -v "$here/../unlisted-policy.json:/unlisted.json:ro" \
  -v "$here/../../agent-boundary/reader-policy.json:/broad.json:ro" \
  --entrypoint sh "$MC_IMAGE" -c '
    set -eu
    mc alias set fx http://'"$NAME"':9000 "$R" "$S" >/dev/null
    mc admin user add fx "$SK" "$SS" >/dev/null
    mc admin user add fx "$BK" "$BS" >/dev/null
    mc admin user add fx "$UK" "$US" >/dev/null
    mc admin policy create fx agent-scoped /scoped.json >/dev/null
    mc admin policy create fx agent-broad /broad.json >/dev/null
    mc admin policy create fx agent-unlisted /unlisted.json >/dev/null
    mc admin policy attach fx agent-scoped --user "$SK" >/dev/null
    mc admin policy attach fx agent-broad --user "$BK" >/dev/null
    mc admin policy attach fx agent-unlisted --user "$UK" >/dev/null
  '

cd "$repo"
S3_SCOPE_SERVER="$SERVER" S3_SCOPE_IMAGE="$IMAGE" S3_SCOPE_PORT="$PORT" S3_SCOPE_OUT="$here" S3_SCOPE_CONTAINER="$NAME" \
  bun "${S3_SCOPE_LIVE:-tests/live/s3-agent-scope.ts}"
