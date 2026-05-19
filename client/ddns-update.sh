#!/bin/bash
# ddns-update.sh - 调用 Cloudflare Worker DDNS 中继上报 IP
#
# 用法:
#   1. 修改下方"配置区"
#   2. chmod +x ddns-update.sh
#   3. 加入 cron: */5 * * * * /usr/local/bin/ddns-update.sh

set -u

# ============ 配置区 ============
WORKER_URL="https://ddns-relay.your-subdomain.workers.dev"
SECRET="REPLACE_WITH_YOUR_SHARED_SECRET"

# 要更新的域名列表(留空数组则使用 Worker ALLOWED_DOMAINS 的第一个域名)
DOMAINS=(
    "home.example.com"
    "nas.example.com"
)

LOG_FILE="/var/log/ddns.log"
TIMEOUT=15

# 是否对 "unchanged" 也写日志(1=是,0=否,静默更省日志空间)
LOG_UNCHANGED=0
# ===============================

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE"
}

call_worker() {
    local domain="$1"
    local url="$WORKER_URL/"
    [ -n "$domain" ] && url="${url}?name=${domain}"

    local response
    response=$(curl -s --max-time "$TIMEOUT" -X POST "$url" \
        -H "X-DDNS-Secret: $SECRET" 2>&1)

    if [ -z "$response" ]; then
        log "FAIL [${domain:-default}]: empty response"
        return 1
    fi

    # 提取关键字段(不依赖 jq)
    local ok action ip
    ok=$(echo "$response"     | grep -oE '"ok":(true|false)' | head -1 | cut -d: -f2)
    action=$(echo "$response" | grep -oE '"action":"[^"]+"'  | head -1 | cut -d'"' -f4)
    ip=$(echo "$response"     | grep -oE '"ip":"[^"]+"'      | head -1 | cut -d'"' -f4)

    if [ "$ok" != "true" ]; then
        log "FAIL [${domain:-default}]: $response"
        return 1
    fi

    case "$action" in
        updated|created)
            log "OK   [${domain:-default}]: $action -> $ip"
            ;;
        unchanged)
            if [ "$LOG_UNCHANGED" = "1" ]; then
                log "OK   [${domain:-default}]: unchanged ($ip)"
            fi
            ;;
        *)
            log "OK   [${domain:-default}]: $action ($ip)"
            ;;
    esac
    return 0
}

# 确保日志文件可写
if [ ! -w "$(dirname "$LOG_FILE")" ] && [ ! -w "$LOG_FILE" ]; then
    echo "ERROR: cannot write to $LOG_FILE" >&2
    exit 1
fi

# 主流程
if [ ${#DOMAINS[@]} -eq 0 ]; then
    call_worker ""
else
    for d in "${DOMAINS[@]}"; do
        call_worker "$d"
    done
fi
