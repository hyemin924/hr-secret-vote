#!/bin/zsh
cd "$(dirname "$0")"

NODE="/Users/oks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="node"
fi

if [ -f "./local.env" ]; then
  set -a
  source "./local.env"
  set +a
fi

echo "인사자문위원회 비밀투표 앱을 시작합니다."
echo "브라우저 주소: http://localhost:4173"
echo "관리자 비밀번호는 설정된 운영 비밀번호를 사용하세요."
echo ""

"$NODE" server.js
