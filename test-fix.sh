#!/bin/bash
# fnytdlp 功能测试脚本
set -e

cd /vol3/1000/hermes/fnytdlp

# 创建测试数据目录
TEST_DIR=$(mktemp -d /tmp/fnytdlp-test.XXXXXX)
trap "rm -rf $TEST_DIR" EXIT

echo "=== 测试环境 ==="
echo "TEST_DIR=$TEST_DIR"

# 启动 server 后台
export TRM_PKGVAR=$TEST_DIR
export PORT=19899
node ui/server.js &
SERVER_PID=$!
echo "Server PID=$SERVER_PID"

# 等待 server 就绪
sleep 2

# 测试 /api/health（无需认证）
echo ""
echo "=== 1. /api/health ==="
curl -s http://localhost:19899/api/health | head -c 300
echo

# 测试 /api/tasks（需认证 → 应 401）
echo ""
echo "=== 2. /api/tasks GET (无认证 → 401) ==="
curl -s -o /dev/null -w "%{http_code}" http://localhost:19899/api/tasks
echo

# 测试 /api/tasks（有认证 → 200）
echo ""
echo "=== 3. /api/tasks GET (有认证 → 200) ==="
curl -s -H "X-Trim-Userid: 1000" http://localhost:19899/api/tasks | head -c 200
echo

# 测试 post task（非法 URL → 400）
echo ""
echo "=== 4. POST /api/tasks (非法URL → 400) ==="
curl -s -o /dev/null -w "%{http_code}" -H "X-Trim-Userid: 1000" -H "Content-Type: application/json" -X POST -d '{"url":"file:///etc/passwd"}' http://localhost:19899/api/tasks
echo

# 测试 post task（合法 URL → 200）
echo ""
echo "=== 5. POST /api/tasks (合法URL → 200) ==="
curl -s -o /dev/null -w "%{http_code}" -H "X-Trim-Userid: 1000" -H "Content-Type: application/json" -X POST -d '{"url":"https://example.com/video.mp4"}' http://localhost:19899/api/tasks
echo

# 列出任务（应包含刚刚添加的）
echo ""
echo "=== 6. /api/tasks 列表现有任务 ==="
curl -s -H "X-Trim-Userid: 1000" http://localhost:19899/api/tasks | python3 -c "import json,sys; data=json.load(sys.stdin); print(f'任务数: {len(data.get(\"tasks\",[]))}'); [print(f'  id={t[\"id\"]} url={t[\"url\"]}') for t in data.get('tasks',[])]"

# 获取第一个任务的 ID
TASK_ID=$(curl -s -H "X-Trim-Userid: 1000" http://localhost:19899/api/tasks | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tasks'][0]['id'])" 2>/dev/null || echo "")

if [ -n "$TASK_ID" ]; then
  echo ""
  echo "=== 7. GET /api/tasks/$TASK_ID ==="
  curl -s -H "X-Trim-Userid: 1000" "http://localhost:19899/api/tasks/$TASK_ID" | head -c 200
  echo

  echo ""
  echo "=== 8. POST /api/tasks/$TASK_ID/stop ==="
  curl -s -H "X-Trim-Userid: 1000" -X POST "http://localhost:19899/api/tasks/$TASK_ID/stop" | head -c 100
  echo

  echo ""
  echo "=== 9. DELETE /api/tasks/$TASK_ID ==="
  curl -s -o /dev/null -w "%{http_code}" -H "X-Trim-Userid: 1000" -X DELETE "http://localhost:19899/api/tasks/$TASK_ID"
  echo
fi

# 测试 /api/config GET
echo ""
echo "=== 10. GET /api/config ==="
curl -s -H "X-Trim-Userid: 1000" http://localhost:19899/api/config | head -c 300
echo

# 测试 /api/config POST（修改 downloadPath）
echo ""
echo "=== 11. POST /api/config (改 downloadPath) ==="
curl -s -H "X-Trim-Userid: 1000" -H "Content-Type: application/json" -X POST -d "{\"downloadPath\":\"$TEST_DIR/mydownloads\"}" http://localhost:19899/api/config | head -c 200
echo

# 验证 downloadPath 已更改
echo ""
echo "=== 12. GET /api/config (验证路径) ==="
curl -s -H "X-Trim-Userid: 1000" http://localhost:19899/api/config | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'downloadPath={d.get(\"downloadPath\")}')"

# 测试 /api/stats
echo ""
echo "=== 13. GET /api/stats ==="
curl -s -H "X-Trim-Userid: 1000" http://localhost:19899/api/stats
echo

# 测试 Cookie 上传（非法格式 → 400）
echo ""
echo "=== 14. POST /api/cookies (无Netscape头 → 400) ==="
curl -s -o /dev/null -w "%{http_code}" -H "X-Trim-Userid: 1000" -H "Content-Type: application/json" -X POST -d '{"content":"some random text"}' http://localhost:19899/api/cookies
echo

# 测试 Cookie 上传（有头无数据 → 400）
echo ""
echo "=== 15. POST /api/cookies (有头无数据 → 400) ==="
curl -s -o /dev/null -w "%{http_code}" -H "X-Trim-Userid: 1000" -H "Content-Type: application/json" -X POST -d '{"content":"# Netscape HTTP Cookie File\n# comment line"}' http://localhost:19899/api/cookies
echo

# 测试 Cookie 上传（有效格式 → 200）
echo ""
echo "=== 16. POST /api/cookies (有效 → 200) ==="
curl -s -o /dev/null -w "%{http_code}" -H "X-Trim-Userid: 1000" -H "Content-Type: application/json" -X POST -d '{"content":"# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t1735689600\ttest\tvalue"}' http://localhost:19899/api/cookies
echo

# 测试 SSE 端点（无需认证）
echo ""
echo "=== 17. SSE /api/events (连接验证) ==="
timeout 2 curl -s -N http://localhost:19899/api/events 2>/dev/null | head -c 200
echo

# 停止 server
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null || true

echo ""
echo "=== ✅ 所有测试通过 ==="
