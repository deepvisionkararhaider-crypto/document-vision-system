#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-http://localhost:8787}"
pass=0; fail=0
check(){ if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass+1)); else echo "FAIL: $3 (got '$1' want '$2')"; fail=$((fail+1)); fi; }
check "$(curl -s "$BASE/api/health" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")" "healthy" "health"
check "$(curl -s "$BASE/api/stats" | python3 -c "import sys,json;print('invoice' in json.load(sys.stdin)['doc_types'])")" "True" "stats doc types"
# extract invoice
code=$(curl -s -o /tmp/dv.json -w "%{http_code}" -X POST "$BASE/api/extract" -H 'Content-Type: application/json' -d '{"doc_type":"invoice","filename":"inv.txt","text":"INVOICE #INV-1\nDate: 2026-01-01\nVendor: Acme\nLine items:\n- Widget qty 2 @ 10.00 = 20.00\nSubtotal: 20.00\nTax: 2.00\nTotal: 22.00"}')
check "$code" "201" "extract invoice"
ok=$(python3 -c "import json;d=json.load(open('/tmp/dv.json'));print('ok' if d.get('fields') else 'bad')")
check "$ok" "ok" "extraction has fields"
# malformed
check "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/extract" -H 'Content-Type: application/json' -d '{"text":""}')" "400" "empty text rejected"
# history
h=$(curl -s "$BASE/api/extractions" | python3 -c "import sys,json;print(json.load(sys.stdin)['count'])")
if [ "$h" -ge 1 ]; then echo "PASS: history persisted"; pass=$((pass+1)); else echo "FAIL: history"; fail=$((fail+1)); fi
echo "---- $pass passed, $fail failed ----"; [ "$fail" -eq 0 ]
