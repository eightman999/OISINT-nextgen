#!/usr/bin/env bash
# secret がリポジトリや Web バンドルへ漏れていないかを検査する（spec.md §34）。
#
# usage:
#   bash scripts/check-secret-leak.sh            # 追跡ファイル（+ dist/ があれば dist/ も）
#   bash scripts/check-secret-leak.sh dist       # 指定ディレクトリのみ
#
# 検出対象は「キー名」ではなく「値らしき文字列」。.env.example のようなキー名のみの記述や
# docs 中の grep 例は誤検知させない。ただし export 済みバンドル（dist/）に限り、
# client へ置いてはいけないキー名の出現自体を NG とする。
set -uo pipefail

fail=0
targets=("$@")

note() { printf '%s\n' "$*"; }
hit() {
  fail=1
  note "NG: $1"
  printf '%s\n' "$2"
}

# 値らしきパターン（キー名だけでは発火しない）
patterns=(
  'AIza[0-9A-Za-z_-]{30,}'
  'GEMINI_API_KEY[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9_-]{16,}'
  'SERPER_API_KEY[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9_-]{16,}'
  'GEOAPIFY_API_KEY[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9_-]{16,}'
  'ONESIGNAL_REST_API_KEY[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9_-]{32,}'
  'HOTPEPPER_API_KEY[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9]{8,}'
  '(SUPABASE_)?SERVICE_ROLE(_KEY)?[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9._-]{20,}'
  'RATE_LIMIT_SECRET[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9._-]{32,}'
  'EGRESS_GATEWAY_SECRET[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9._-]{32,}'
  'INTERNAL_INVOKE_SECRET(_PREVIOUS)?[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9._-]{32,}'
  'CLOUDFLARE_API_TOKEN[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9._-]{20,}'
  'SUPABASE_ACCESS_TOKEN[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9._-]{20,}'
  'SUPABASE_DB_PASSWORD[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9._-]{16,}'
  'sk-[A-Za-z0-9]{20,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'ghp_[A-Za-z0-9]{30,}'
)

# JWT は形だけでは anon key と service_role key を区別できない。
# anon key は client への埋め込みが正当（spec.md §34）なので、形で一律 NG にすると
# 本番 export が必ず落ちる。payload をデコードして role を見て判定する。
jwt_pattern='eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'

b64d() {
  printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D 2>/dev/null
}

# JWT の payload（2番目のセグメント）をデコードして返す
jwt_claims() {
  local payload="${1#*.}"
  payload="${payload%%.*}"
  payload="${payload//-/+}"
  payload="${payload//_//}"
  case $(( ${#payload} % 4 )) in
    2) payload="${payload}==" ;;
    3) payload="${payload}=" ;;
  esac
  b64d "$payload"
}

# stdin: "file:line:token" 形式。anon 以外（service_role / role 判別不能）だけを残す。
filter_non_anon_jwt() {
  local line token
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    token="${line##*:}"
    if jwt_claims "$token" | grep -qE '"role"[[:space:]]*:[[:space:]]*"anon"'; then
      continue
    fi
    printf '%s\n' "$line"
  done
}

exclude_noise() {
  grep -vE '(^|/)scripts/check-secret-leak\.sh' |
    grep -vaiE 'your[-_]?(api[-_]?)?key|<[A-Za-z_-]+>|xxxx|YOUR_|EXAMPLE|placeholder|\.\.\.'
}

# 1) git 追跡ファイル
if [ ${#targets[@]} -eq 0 ]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    for p in "${patterns[@]}"; do
      out=$(git ls-files -z | xargs -0 --no-run-if-empty grep -InE "$p" 2>/dev/null | exclude_noise)
      [ -n "$out" ] && hit "追跡ファイルに secret らしき値: /$p/" "$out"
    done
    out=$(git ls-files -z | xargs -0 --no-run-if-empty grep -oInE "$jwt_pattern" 2>/dev/null | exclude_noise | filter_non_anon_jwt)
    [ -n "$out" ] && hit "追跡ファイルに anon 以外の JWT（service_role の疑い）" "$out"
  fi
  [ -d dist ] && targets=(dist)
fi

# 2) ディレクトリ（dist/ など。git 管理外も走査）
for dir in ${targets[@]+"${targets[@]}"}; do
  if [ ! -d "$dir" ]; then
    note "skip: $dir が存在しない"
    continue
  fi
  for p in "${patterns[@]}"; do
    out=$(grep -rInE "$p" "$dir" 2>/dev/null | exclude_noise)
    [ -n "$out" ] && hit "$dir に secret らしき値: /$p/" "$out"
  done
  # anon key の出現は正当なので、role を見て anon 以外だけを NG にする
  out=$(grep -roInE "$jwt_pattern" "$dir" 2>/dev/null | exclude_noise | filter_non_anon_jwt)
  [ -n "$out" ] && hit "$dir に anon 以外の JWT（service_role の疑い）" "$out"
  out=$(grep -rInE \
    'SERVICE_ROLE|HOTPEPPER_API_KEY|GEMINI_API_KEY|SERPER_API_KEY|GEOAPIFY_API_KEY|ONESIGNAL_REST_API_KEY|RATE_LIMIT_SECRET|EGRESS_GATEWAY_SECRET|INTERNAL_INVOKE_SECRET|CLOUDFLARE_API_TOKEN|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD' \
    "$dir" 2>/dev/null | exclude_noise)
  [ -n "$out" ] && hit "$dir に client へ置いてはいけないキー名が含まれている" "$out"
done

if [ "$fail" -ne 0 ]; then
  note ""
  note "secret leak scan FAILED。値をコミットした場合はキーを失効させ、履歴からも除去すること。"
  exit 1
fi

note "secret leak scan PASSED"
