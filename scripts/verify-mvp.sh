#!/usr/bin/env bash
#
# MVP 一键验收：起 demo 靶子 → 跑 CLI（dry-run）→ 报告路径与失败计数。
#
# 这是 MVP 唯一的「硬证据」：不是「我觉得它能跑」，而是这条命令在干净的仓库里
# 退出码为 0。所以每一步都失败即停，任何一步出错都不会被后面的成功掩盖。
#
# 用法：
#   ./scripts/verify-mvp.sh
#   PORT=5000 ./scripts/verify-mvp.sh
#
# 前置条件：Node.js >= 20，并且已经 npm install（探测 / 执行要用 playwright）。
# 产物留在 autotest-output/verify-mvp/（已在 .gitignore 里）：report.md 是给人看的证据，
# 跑完不会污染工作区，也不会建分支或提交。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-4173}"
OUTPUT_DIR="autotest-output/verify-mvp"
CONFIG_FILE="$OUTPUT_DIR/autotest.config.json"
SERVER_LOG="$OUTPUT_DIR/demo-server.log"
CLI_LOG="$OUTPUT_DIR/cli.log"
REPORT_FILE="$OUTPUT_DIR/report.md"

SERVER_PID=""
CLI_STATUS=0
PASSED="?"
FAILED="?"
FLAKY="?"
ERRORS="?"

cleanup() {
  # 先停进程再退出：靶子占着端口会让下一次验收直接失败。
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
# 退出时一定清理；Ctrl-C 也走同一条清理路径，然后以非 0 退出。
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "✗ $*" >&2
  exit 1
}

echo "== 1/4 检查运行环境"

command -v node >/dev/null 2>&1 || fail "找不到 node，请先安装 Node.js >= 20"

NODE_VERSION="$(node --version)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  fail "需要 Node.js >= 20，当前是 $NODE_VERSION"
fi
echo "   node $NODE_VERSION"

if ! node -e "import('playwright').then(() => process.exit(0), () => process.exit(1))" >/dev/null 2>&1; then
  fail "找不到 playwright，先在仓库根目录执行 npm install"
fi
echo "   playwright 已安装"

mkdir -p "$OUTPUT_DIR"

cat > "$CONFIG_FILE" <<JSON
{
  "target": {
    "baseUrl": "http://127.0.0.1:${PORT}",
    "routes": ["/"]
  },
  "limits": {
    "maxCases": 6,
    "maxWallMs": 180000,
    "maxSteps": 8
  },
  "runner": {
    "repeat": 1
  },
  "output": {
    "dir": "${OUTPUT_DIR}"
  },
  "testsDir": "test/"
}
JSON
echo "   配置：$CONFIG_FILE"

echo "== 2/4 启动 demo-app（端口 $PORT）"

node demo-app/server.mjs --port "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

READY=0
for _ in $(seq 1 50); do
  if node -e "fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  # 进程已经退出就没必要再等满 10 秒，直接把日志贴出来。
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

if [[ "$READY" -ne 1 ]]; then
  echo "--- demo-app 日志 ---" >&2
  cat "$SERVER_LOG" >&2 || true
  fail "demo-app 没有在 http://127.0.0.1:${PORT}/health 就绪"
fi
echo "   /health 就绪（pid $SERVER_PID）"

echo "== 3/4 跑 CLI（dry-run，不碰 git）"

set +e
node src/cli.mjs run --config "$CONFIG_FILE" --dry-run 2>&1 | tee "$CLI_LOG"
CLI_STATUS="${PIPESTATUS[0]}"
set -e

SUMMARY_LINE="$(grep -E '^  *通过 ' "$CLI_LOG" | tail -n 1 || true)"
if [[ "$SUMMARY_LINE" =~ 通过\ ([0-9]+)\ /\ 失败\ ([0-9]+)\ /\ flaky\ ([0-9]+)\ /\ 错误\ ([0-9]+) ]]; then
  PASSED="${BASH_REMATCH[1]}"
  FAILED="${BASH_REMATCH[2]}"
  FLAKY="${BASH_REMATCH[3]}"
  ERRORS="${BASH_REMATCH[4]}"
fi

echo "== 4/4 验收结果"

if [[ "$CLI_STATUS" -ne 0 ]]; then
  # 失败也要把证据留在屏上：报告在就报路径与计数，再带着 CLI 的退出码退出。
  if [[ -f "$REPORT_FILE" ]]; then
    echo "   报告：$ROOT_DIR/$REPORT_FILE"
    echo "   通过 ${PASSED} / 失败 ${FAILED} / flaky ${FLAKY} / 错误 ${ERRORS}"
  else
    echo "   没有生成报告（CLI 在流水线中途退出）" >&2
  fi
  echo "✗ CLI 退出码 $CLI_STATUS：有用例失败、运行被中止，或流水线本身出错" >&2
  echo "  报告里写明每条失败用例的输入 / 期望 / 实际，先看报告再判断是 bug 还是用例问题" >&2
  exit "$CLI_STATUS"
fi

# 退出码 0 还不够：报告必须真的存在，否则「跑通了」就没有可复核的证据。
[[ -f "$REPORT_FILE" ]] || fail "CLI 退出码为 0，但没有生成报告：$REPORT_FILE"
echo "   报告：$ROOT_DIR/$REPORT_FILE"
echo "   通过 ${PASSED} / 失败 ${FAILED} / flaky ${FLAKY} / 错误 ${ERRORS}"

echo "✓ MVP 验收通过：探测 → 规划 → 执行 → 生成测试代码 → 报告 全链路跑通"
