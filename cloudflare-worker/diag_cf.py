import json
import os
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, ".cf_creds.json"), encoding="utf-8") as f:
    creds = json.load(f)
ACCT = creds["account_id"]
TOKEN = creds["api_token"]
API = "https://api.cloudflare.com/client/v4"


def call(path):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:300]}
    except Exception as e:
        return 0, {"err": str(e)}


print("=== 1. Token 有效性 ===")
st, d = call("/user/tokens/verify")
print("HTTP", st, "| result:", json.dumps(d.get("result"), ensure_ascii=False))
if d.get("errors"):
    print("  errors:", json.dumps(d["errors"], ensure_ascii=False))
if d.get("messages"):
    print("  messages:", json.dumps(d["messages"], ensure_ascii=False))

print()
print("=== 2. 该 Token 能看到哪些账户（用于核对 Account ID）===")
st, d = call("/accounts")
print("HTTP", st)
if d.get("success") and d.get("result"):
    for a in d["result"]:
        mark = "  <== 你给我的" if a["id"] == ACCT else ""
        print(f"  {a['id']}  {a.get('name','')}{mark}")
else:
    print("  errors:", json.dumps(d.get("errors"), ensure_ascii=False))

print()
print("=== 3. 直接读该账户下的 Workers（验证 Workers 权限）===")
st, d = call("/accounts/%s/workers/scripts" % ACCT)
print("HTTP", st, "| success:", d.get("success"))
if not d.get("success"):
    print("  errors:", json.dumps(d.get("errors"), ensure_ascii=False))
else:
    print("  已有脚本:", [s.get("id") for s in (d.get("result") or [])])

print()
print("=== 4. workers.dev 子域状态 ===")
st, d = call("/accounts/%s/workers/subdomain" % ACCT)
print("HTTP", st, "|", json.dumps(d.get("result"), ensure_ascii=False))
if not d.get("success"):
    print("  errors:", json.dumps(d.get("errors"), ensure_ascii=False))
