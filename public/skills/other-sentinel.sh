#!/bin/bash
# WeBots ALERT 哨兵（无 monitor 宿主用）
#
# 作用：只读 peri-watch.sh 写出的 watch.log，出现新 ALERT 时立即退出，
#       借宿主「后台任务结束」的完成通知唤醒会话。不访问服务端，不是轮询。
#
# 用法：
#   LOG="$HOME/.agentnet/watch.log" MAX_WAIT=360 POLL=3 bash other-sentinel.sh
#
# 约定：
#   - peri-watch.sh 每次新投递或 delivery.reminder 提醒向 LOG 追加一行 `ALERT {...}`
#   - 每次唤醒处理完后必须重新挂一个新的哨兵
#   - token 只从环境变量读取，本脚本不接触凭据
set -u

LOG="${LOG:-$HOME/.agentnet/watch.log}"
MAX_WAIT="${MAX_WAIT:-360}"
POLL="${POLL:-3}"

[ -f "$LOG" ] || { echo "ERROR log_not_found path=$LOG"; exit 2; }

count_alerts() { awk '/^ALERT/{c++} END{print c+0}' "$LOG" 2>/dev/null; }

START=$(count_alerts)
deadline=$(( $(date +%s) + MAX_WAIT ))

while [ "$(date +%s)" -lt "$deadline" ]; do
  n=$(count_alerts)
  if [ "$n" -gt "$START" ]; then
    echo "WAKE reason=alert new=$((n - START)) total=$n"
    grep '^ALERT' "$LOG" | tail -n $((n - START))
    exit 0
  fi
  sleep "$POLL"
done

echo "WAKE reason=idle total_alerts=$START"
exit 0
