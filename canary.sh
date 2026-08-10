#!/usr/bin/env bash
# Exercise the deployed Nx cache's write/read-only/concurrency contract and
# publish a success timestamp for Prometheus. Legacy scalar tokens or a named
# token map are selected locally and passed to curl through mode-0600 header
# files so they never appear in argv or output.
set -euo pipefail

readonly CACHE_URL="${CACHE_URL:-http://127.0.0.1:3000}"
readonly TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/prometheus/node-exporter}"
readonly METRIC_FILE="$TEXTFILE_DIR/nx_cache_canary.prom"

scratch=$(mktemp -d)
metric_tmp=""
cleanup() {
  rm -rf "$scratch"
  [[ -z "$metric_tmp" ]] || rm -f "$metric_tmp"
}
trap cleanup EXIT

write_header="$scratch/write.header"
read_header="$scratch/read.header"

if [[ -n "${NX_CACHE_TOKENS_FILE:-}" ]]; then
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  node - "$script_dir/server.js" "$NX_CACHE_TOKENS_FILE" "$write_header" "$read_header" <<'NODE'
const fs = require('fs');

const [serverPath, tokensPath, writeHeader, readHeader] = process.argv.slice(2);
const { parseTokenMap } = require(serverPath);
const candidates = parseTokenMap(fs.readFileSync(tokensPath, 'utf8'));
const write = candidates.find(({ role }) => role === 'write');
const read = candidates.find(({ role }) => role === 'read');
if (!read) {
  throw new Error('token map must include a read-role entry for the live canary');
}
fs.writeFileSync(writeHeader, `Authorization: Bearer ${write.token}\n`, {
  mode: 0o600,
});
fs.writeFileSync(readHeader, `Authorization: Bearer ${read.token}\n`, {
  mode: 0o600,
});
NODE
else
  : "${NX_CACHE_ACCESS_TOKEN:?NX_CACHE_ACCESS_TOKEN is required}"
  : "${NX_CACHE_READ_ONLY_ACCESS_TOKEN:?NX_CACHE_READ_ONLY_ACCESS_TOKEN is required}"
  if [[ "$NX_CACHE_ACCESS_TOKEN" == "$NX_CACHE_READ_ONLY_ACCESS_TOKEN" ]]; then
    echo "write and read-only cache tokens must be distinct" >&2
    exit 1
  fi
  printf 'Authorization: Bearer %s\n' "$NX_CACHE_ACCESS_TOKEN" >"$write_header"
  printf 'Authorization: Bearer %s\n' "$NX_CACHE_READ_ONLY_ACCESS_TOKEN" >"$read_header"
fi
chmod 0600 "$write_header" "$read_header"

started_at=$(date +%s)
nonce="$(hostname)-$started_at-$RANDOM-$RANDOM"
cache_hash=$(printf '%s' "$nonce" | sha256sum | cut -d' ' -f1)
denied_hash="${cache_hash}r"
original_body="$scratch/original"
replacement_body="$scratch/replacement"
response_body="$scratch/response"
printf 'nx-cache-canary:%s\n' "$nonce" >"$original_body"
printf 'nx-cache-canary-replacement:%s\n' "$nonce" >"$replacement_body"

request() {
  local method="$1"
  local header_file="$2"
  local hash="$3"
  local input_file="$4"
  local output_file="$5"
  local -a args=(
    --silent
    --show-error
    --connect-timeout 5
    --max-time 30
    --request "$method"
    --header "@$header_file"
    --output "$output_file"
    --write-out '%{http_code}'
  )
  if [[ -n "$input_file" ]]; then
    args+=(--data-binary "@$input_file")
  fi
  curl "${args[@]}" "${CACHE_URL%/}/v1/cache/$hash"
}

health_status=$(
  curl --silent --show-error --connect-timeout 5 --max-time 10 \
    --output /dev/null --write-out '%{http_code}' "${CACHE_URL%/}/healthz"
)
[[ "$health_status" == "200" ]] || {
  echo "cache health probe returned $health_status, expected 200" >&2
  exit 1
}

write_status=$(request PUT "$write_header" "$cache_hash" "$original_body" /dev/null)
[[ "$write_status" == "200" ]] || {
  echo "write-token PUT returned $write_status, expected 200" >&2
  exit 1
}

read_status=$(request GET "$read_header" "$cache_hash" "" "$response_body")
[[ "$read_status" == "200" ]] || {
  echo "read-only GET returned $read_status, expected 200" >&2
  exit 1
}
cmp --silent "$original_body" "$response_body" || {
  echo "read-only GET returned content that differs from the published body" >&2
  exit 1
}

readonly_put_status=$(request PUT "$read_header" "$denied_hash" "$replacement_body" /dev/null)
[[ "$readonly_put_status" == "403" ]] || {
  echo "read-only PUT returned $readonly_put_status, expected 403" >&2
  exit 1
}

denied_get_status=$(request GET "$write_header" "$denied_hash" "" /dev/null)
[[ "$denied_get_status" == "404" ]] || {
  echo "denied read-only PUT unexpectedly published content (GET $denied_get_status)" >&2
  exit 1
}

conflict_status=$(request PUT "$write_header" "$cache_hash" "$replacement_body" /dev/null)
[[ "$conflict_status" == "409" ]] || {
  echo "second write-token PUT returned $conflict_status, expected 409" >&2
  exit 1
}

final_status=$(request GET "$read_header" "$cache_hash" "" "$response_body")
[[ "$final_status" == "200" ]] || {
  echo "final read-only GET returned $final_status, expected 200" >&2
  exit 1
}
cmp --silent "$original_body" "$response_body" || {
  echo "conflicting PUT replaced the first published body" >&2
  exit 1
}

finished_at=$(date +%s)
mkdir -p "$TEXTFILE_DIR"
metric_tmp=$(mktemp "$TEXTFILE_DIR/.nx_cache_canary.prom.XXXXXX")
{
  printf 'node_nx_cache_canary_last_success_timestamp_seconds %s\n' "$finished_at"
  printf 'node_nx_cache_canary_duration_seconds %s\n' "$((finished_at - started_at))"
} >"$metric_tmp"
chmod 0644 "$metric_tmp"
mv "$metric_tmp" "$METRIC_FILE"
metric_tmp=""

echo "✓ Nx cache canary passed: write=200 read=200 readonly-put=403 conflict=409 immutable=yes"
