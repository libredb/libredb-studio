#!/bin/sh
# The one object seed of the S3 fixtures (docker/s3/README.md): the same buckets, keys and bytes on every server.
#
#   seed.sh <endpoint> <region> <server>               every bucket and object of docker/s3/README.md
#   seed.sh --raw <dir> <endpoint> <region> <server>   only the run-time objects tests/live/s3-seed-raw.ts wrote to <dir>
#
# <server> is minio, silo, garage or rustfs: it selects how buckets are made and which outcome each special key
# must have. Signing is curl's own --aws-sigv4, the request helper every live measurement used, and --path-as-is is
# on every curl line, because without it curl removes ./ and ../ segments and Garage would store other keys. Keys
# are written on the wire in their RFC 3986 form by this script, never by curl. Each bucket ends on a known last
# object: a bucket whose last object exists is skipped whole, so a second run writes nothing and an interrupted run
# is completed by the next. The secret is never printed.
set -eu

RAW=""
if [ "${1:-}" = "--raw" ]; then
  RAW="$2"
  shift 2
fi
ENDPOINT="$1"
REGION="$2"
SERVER="$3"
case "$SERVER" in
  minio | silo | garage | rustfs) ;;
  *)
    echo "seed.sh: unknown server $SERVER" >&2
    exit 2
    ;;
esac
ACCESS="${S3_SEED_ACCESS_KEY:?set S3_SEED_ACCESS_KEY}"
if [ -n "${S3_SEED_SECRET_KEY_FILE:-}" ]; then
  SECRET="$(cat "$S3_SEED_SECRET_KEY_FILE")"
else
  SECRET="${S3_SEED_SECRET_KEY:?set S3_SEED_SECRET_KEY}"
fi
CA=""
if [ -n "${S3_SEED_CA:-}" ]; then CA="--cacert $S3_SEED_CA"; fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
written=0
skipped=0

fail() {
  echo "seed.sh: $*" >&2
  exit 1
}

# s3 <method> <wire path and query> [curl arguments...]: one signed request. Prints the status; the body is left
# in $WORK/body and the headers in $WORK/headers.
s3() {
  method="$1"
  target="$2"
  shift 2
  # shellcheck disable=SC2086 # $CA is empty or two words on purpose
  curl --path-as-is -sS $CA -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' -X "$method" \
    --aws-sigv4 "aws:amz:$REGION:s3" --user "$ACCESS:$SECRET" "$@" "$ENDPOINT$target" || true
}

# head_status <wire path>: the status of a signed HEAD; its headers are left in $WORK/headers.
head_status() {
  # shellcheck disable=SC2086
  curl --path-as-is -sS $CA -o /dev/null -D "$WORK/headers" -I -w '%{http_code}' \
    --aws-sigv4 "aws:amz:$REGION:s3" --user "$ACCESS:$SECRET" "$ENDPOINT$1" || true
}

# head_size <wire path>: the stored size, or nothing when the object is missing.
head_size() {
  if [ "$(head_status "$1")" = 200 ]; then
    tr -d '\r' < "$WORK/headers" | sed -n 's/^[Cc]ontent-[Ll]ength: *//p'
  fi
}

# expect <what> <wanted> <received>: stops with the server's error body unless the two are equal.
expect() {
  [ "$3" = "$2" ] || fail "$1: expected $2, received $3: $(head -c 300 "$WORK/body" 2>/dev/null | tr -d '\n')"
}

# put <bucket> <wire key> <content type, or - for none> <body file> [curl arguments...]
put() {
  bucket="$1"
  key="$2"
  type="$3"
  file="$4"
  shift 4
  if [ "$type" = "-" ]; then header="Content-Type:"; else header="Content-Type: $type"; fi
  expect "PUT $bucket/$key" 200 "$(s3 PUT "/$bucket/$key" -H "$header" --data-binary "@$file" "$@")"
  written=$((written + 1))
}

# make_bucket <name>: creates the bucket when HEAD answers 404. Garage's buckets come from garage-setup.sh.
make_bucket() {
  [ "$SERVER" = garage ] && return 0
  status="$(head_status "/$1")"
  case "$status" in
    200) ;;
    404) expect "PUT /$1" 200 "$(s3 PUT "/$1")" ;;
    *) fail "HEAD /$1: expected 200 or 404, received $status" ;;
  esac
}

# seg <n>: abcdefghijklmnopqrstuvwxyz repeated and cut to n characters.
seg() {
  printf 'abcdefghijklmnopqrstuvwxyz%.0s' 1 2 3 4 5 6 7 8 9 10 | cut -c1-"$1"
}
LONG="$(seg 250)/$(seg 250)/$(seg 250)/$(seg 245)"

# The special keys: the wire form (RFC 3986, upper-case hex, "/" kept), then the outcome on MinIO (and the MinIO
# region variant), Silo, Garage and RustFS: stored, <status>:<code> for a refusal, or measure for a cell the
# first seed run measures and docker/s3/README.md records. Each key is stored with the body of root.txt.
SPECIAL_KEYS='
sp/with%20space.txt|stored|stored|stored|stored
sp/plus%2Bsign.txt|stored|stored|stored|stored
sp/percent%25sign.txt|stored|stored|stored|stored
sp/%C3%BCn%C3%AFc%C3%B8d%C3%A9-%E6%97%A5%E6%9C%AC.txt|stored|stored|stored|stored
sp/lt%3Camp%26.txt|stored|measure|stored|measure
sp/.hidden|stored|measure|measure|stored
sp/trail.|stored|measure|measure|measure
sp/lit%252Fname.txt|stored|measure|measure|measure
sp/tab%09char.txt|measure|measure|stored|measure
ctl/x%01y.txt|measure|measure|stored|measure
long/@LONG@|stored|measure|measure|measure
sp/double//slash.txt|400:XMinioInvalidObjectName|400:XMinioInvalidObjectName|stored|400:InvalidArgument
sp/./dot.txt|400:XMinioInvalidResourceName|measure|stored|400:InvalidArgument
sp/x/../dotdot.txt|400:XMinioInvalidResourceName|measure|stored|400:InvalidArgument
'

seed_special() {
  printf '%s\n' "$SPECIAL_KEYS" | while IFS='|' read -r wire minio silo garage rustfs; do
    [ -n "$wire" ] || continue
    wire="$(printf '%s' "$wire" | sed "s|@LONG@|$LONG|")"
    case "$SERVER" in
      minio) want="$minio" ;;
      silo) want="$silo" ;;
      garage) want="$garage" ;;
      rustfs) want="$rustfs" ;;
    esac
    status="$(s3 PUT "/studio-demo/$wire" -H 'Content-Type: text/plain' --data-binary "@$WORK/root")"
    code="$(sed -n 's:.*<Code>\([^<]*\)</Code>.*:\1:p' "$WORK/body" 2>/dev/null | head -n 1)"
    case "$want" in
      stored) expect "PUT studio-demo/$wire" 200 "$status" ;;
      measure)
        case "$status" in
          200 | 4??) echo "seed.sh: measured $SERVER studio-demo/$wire: $status${code:+:$code}" ;;
          *) fail "PUT studio-demo/$wire: expected 200 or a 4xx status, received $status" ;;
        esac
        ;;
      *) expect "PUT studio-demo/$wire" "$want" "$status${code:+:$code}" ;;
    esac
  done
}

# meta/tagged.txt, with one user metadata value in non-ASCII UTF-8 text. What each server answers for it is printed as
# measured, never hidden: the value it hands back on HEAD, stored as sent or rewritten (for example as an RFC 2047
# encoded word), or its refusal, after which the object is written without that one value so the other metadata
# reads still find it.
seed_tagged() {
  status="$(s3 PUT /studio-demo/meta/tagged.txt -H 'Content-Type: text/plain' --data-binary "@$WORK/root" \
    -H 'x-amz-meta-project: libredb' -H 'x-amz-meta-owner: probe' -H 'x-amz-meta-note: café' \
    -H 'x-amz-tagging: env=probe&tier=gold')"
  case "$status" in
    200)
      written=$((written + 1))
      expect "HEAD studio-demo/meta/tagged.txt" 200 "$(head_status /studio-demo/meta/tagged.txt)"
      note="$(tr -d '\r' < "$WORK/headers" | sed -n 's/^[Xx]-[Aa][Mm][Zz]-[Mm][Ee][Tt][Aa]-[Nn][Oo][Tt][Ee]: *//p')"
      echo "seed.sh: measured $SERVER studio-demo/meta/tagged.txt x-amz-meta-note: ${note:-absent}"
      ;;
    4??)
      code="$(sed -n 's:.*<Code>\([^<]*\)</Code>.*:\1:p' "$WORK/body" 2>/dev/null | head -n 1)"
      echo "seed.sh: measured $SERVER studio-demo/meta/tagged.txt x-amz-meta-note refused: $status${code:+:$code}"
      put studio-demo meta/tagged.txt text/plain "$WORK/root" \
        -H 'x-amz-meta-project: libredb' -H 'x-amz-meta-owner: probe' -H 'x-amz-tagging: env=probe&tier=gold'
      ;;
    *) fail "PUT studio-demo/meta/tagged.txt: expected 200 or a 4xx status, received $status" ;;
  esac
}

seed_multipart() {
  : > "$WORK/part1"
  for _ in 1 2 3 4 5; do cat /s3/data/one-mib.bin >> "$WORK/part1"; done
  expect "POST uploads" 200 "$(s3 POST "/studio-demo/data/multipart.bin?uploads=" -H 'Content-Type: application/octet-stream')"
  upload="$(sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p' "$WORK/body" | head -n 1)"
  [ -n "$upload" ] || fail "POST uploads answered without an UploadId"
  upload="$(printf '%s' "$upload" | sed 's/%/%25/g; s/+/%2B/g; s/\//%2F/g; s/=/%3D/g')"
  : > "$WORK/parts"
  for n in 1 2; do
    if [ "$n" = 1 ]; then file="$WORK/part1"; else file=/s3/data/one-mib.bin; fi
    expect "PUT part $n" 200 "$(s3 PUT "/studio-demo/data/multipart.bin?partNumber=$n&uploadId=$upload" --data-binary "@$file")"
    etag="$(tr -d '\r' < "$WORK/headers" | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p')"
    printf '<Part><PartNumber>%s</PartNumber><ETag>%s</ETag></Part>' "$n" "$etag" >> "$WORK/parts"
  done
  printf '<CompleteMultipartUpload>%s</CompleteMultipartUpload>' "$(cat "$WORK/parts")" > "$WORK/complete"
  expect "POST complete" 200 "$(s3 POST "/studio-demo/data/multipart.bin?uploadId=$upload" --data-binary "@$WORK/complete")"
  expect "the size of data/multipart.bin" 6291456 "$(head_size /studio-demo/data/multipart.bin)"
  written=$((written + 1))
}

seed_demo() {
  if [ "$(head_status /studio-demo/parquet/truncated.parquet)" = 200 ]; then
    skipped=$((skipped + 1))
    return 0
  fi
  for key in root.txt a/top.txt a/b/c.txt a/b/c/d/e/deep.txt dir/child.txt keys/dirmarker/inner.txt; do
    put studio-demo "$key" text/plain "$WORK/root"
  done
  put studio-demo dir/ application/x-directory "$WORK/empty"
  printf 'marker!!\n' > "$WORK/marker"
  put studio-demo keys/dirmarker/ text/plain "$WORK/marker"
  seed_tagged
  put studio-demo data/table.csv text/csv "$WORK/table.csv"
  printf 'id\tname\tamount\n1\talice\t10.5\n2\tbob\t20\n3\tcarol, jr\t30\n4\tmulti line\t40\n' > "$WORK/table.tsv"
  put studio-demo data/table.tsv text/tab-separated-values "$WORK/table.tsv"
  printf '{"items":[{"id":1},{"id":2}],"ok":true}\n' > "$WORK/doc.json"
  put studio-demo data/doc.json application/json "$WORK/doc.json"
  put studio-demo data/truncated.json application/json /s3/data/truncated.json
  printf '{"id":1,"name":"alice"}\n{"id":2,"name":"bob"}\n{"id":3,"name":"carol"}\n' > "$WORK/rows.ndjson"
  # Stored as application/octet-stream on purpose (row A36).
  put studio-demo data/rows.ndjson application/octet-stream "$WORK/rows.ndjson"
  put studio-demo data/rows-partial.ndjson application/x-ndjson /s3/data/rows-partial.ndjson
  put studio-demo data/rows.ndjson.gz application/x-ndjson /preview/rows.ndjson.gz -H 'Content-Encoding: gzip'
  put studio-demo data/bomb.ndjson.gz application/x-ndjson /s3/data/bomb.ndjson.gz -H 'Content-Encoding: gzip'
  put studio-demo data/utf8-boundary.txt 'text/plain; charset=utf-8' /s3/data/utf8-boundary.txt
  # No Content-Type at all (row A42).
  put studio-demo data/noext - /s3/data/noext
  put studio-demo data/empty.txt text/plain "$WORK/empty"
  put studio-demo data/one-mib.bin application/octet-stream /s3/data/one-mib.bin
  seed_multipart
  seed_special
  put studio-demo parquet/fx-uncompressed.parquet binary/octet-stream /preview/fx-uncompressed.parquet
  put studio-demo parquet/fx-snappy.parquet binary/octet-stream /preview/fx-snappy.parquet
  put studio-demo parquet/fx-gzip.parquet binary/octet-stream /preview/fx-gzip.parquet
  put studio-demo parquet/fx-zstd.parquet binary/octet-stream /preview/fx-zstd.parquet
  put studio-demo parquet/fx-brotli.parquet binary/octet-stream /preview/fx-brotli.parquet
  put studio-demo parquet/fx-lz4_raw.parquet binary/octet-stream /preview/fx-lz4_raw.parquet
  put studio-demo parquet/fx-two-groups.parquet binary/octet-stream /preview/fx-two-groups.parquet
  put studio-demo parquet/fx-empty.parquet binary/octet-stream /preview/fx-empty.parquet
  put studio-demo parquet/bigcells-zstd.parquet binary/octet-stream /preview/bigcells-zstd.parquet
  put studio-demo parquet/not-parquet.parquet binary/octet-stream "$WORK/table.csv"
  # The bucket's last object: its presence means studio-demo is complete.
  put studio-demo parquet/truncated.parquet binary/octet-stream /s3/data/truncated.parquet
}

seed_scoped() {
  if [ "$(head_status /studio-scoped/b-only/table.csv)" = 200 ]; then
    skipped=$((skipped + 1))
    return 0
  fi
  put studio-scoped b-only/x.txt text/plain "$WORK/root"
  put studio-scoped b-only/table.csv text/csv "$WORK/table.csv"
}

seed_versions() {
  if [ "$(head_status /studio-versions/ver/zz-last.txt)" = 200 ]; then
    skipped=$((skipped + 1))
    return 0
  fi
  # Garage has no versioning (PUT ?versioning answers 501), so there the bucket is written as an unversioned one.
  if [ "$SERVER" != garage ]; then
    expect "GET /studio-versions?versions" 200 "$(s3 GET "/studio-versions?versions=&prefix=ver%2F")"
    if grep -q -e '<Version>' -e '<DeleteMarker>' "$WORK/body"; then
      fail "studio-versions holds a partial seed; reset the server with rm -s -f -v and run again"
    fi
    printf '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' > "$WORK/versioning"
    expect "PUT /studio-versions?versioning" 200 "$(s3 PUT "/studio-versions?versioning=" --data-binary "@$WORK/versioning")"
  fi
  printf 'version one\n' > "$WORK/v1"
  printf 'version two\n' > "$WORK/v2"
  put studio-versions ver/doc.txt text/plain "$WORK/v1"
  put studio-versions ver/doc.txt text/plain "$WORK/v2"
  put studio-versions ver/deleted.txt text/plain "$WORK/root"
  expect "DELETE studio-versions/ver/deleted.txt" 204 "$(s3 DELETE /studio-versions/ver/deleted.txt)"
  put studio-versions ver/zz-last.txt text/plain "$WORK/root"
}

seed_bulk() {
  if [ "$(head_status /studio-bulk/mixed/k-1199/inner.txt)" = 200 ]; then
    skipped=$((skipped + 1))
    return 0
  fi
  for i in $(seq 0 2499); do put studio-bulk "many/k-$(printf '%04d' "$i")" text/plain "$WORK/x"; done
  for i in $(seq 0 1099); do put studio-bulk "folders/f-$(printf '%04d' "$i")/only.txt" text/plain "$WORK/x"; done
  for i in $(seq 0 1199); do
    n="$(printf '%04d' "$i")"
    if [ $((i % 2)) -eq 0 ]; then
      put studio-bulk "mixed/k-$n" text/plain "$WORK/x"
    else
      put studio-bulk "mixed/k-$n/inner.txt" text/plain "$WORK/x"
    fi
  done
}

# The run-time objects of tests/live/s3-seed-raw.ts: the large Parquet files and the held/ keys.
seed_raw() {
  find "$RAW/parquet/large" -type f | sort > "$WORK/large"
  while read -r file; do
    key="parquet/large/${file#"$RAW"/parquet/large/}"
    size="$(wc -c < "$file" | tr -d ' ')"
    if [ "$(head_size "/studio-demo/$key")" = "$size" ]; then continue; fi
    put studio-demo "$key" binary/octet-stream "$file"
  done < "$WORK/large"
  if [ "$(head_status /studio-bulk/held/k-10049)" = 200 ]; then
    skipped=$((skipped + 1))
    return 0
  fi
  for i in $(seq 0 10049); do put studio-bulk "held/k-$(printf '%05d' "$i")" text/plain "$WORK/x"; done
}

printf 'hello depth\n' > "$WORK/root"
: > "$WORK/empty"
printf 'x' > "$WORK/x"
printf 'id,name,amount\n1,alice,10.5\n2,bob,20\n3,"carol, jr",30\n4,"multi\nline",40\n' > "$WORK/table.csv"

if [ -n "$RAW" ]; then
  seed_raw
else
  for bucket in studio-demo studio-scoped studio-versions studio-bulk studio-empty; do make_bucket "$bucket"; done
  seed_demo
  seed_scoped
  seed_versions
  seed_bulk
fi
echo "seed.sh: $SERVER $written objects written, $skipped buckets skipped"
