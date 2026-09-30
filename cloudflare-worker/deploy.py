#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 sign-worker.js 部署到 Cloudflare（纯 API，不需要 wrangler）。

凭据优先级
----------
1. 环境变量  CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
2. 文件      cloudflare-worker/.cf_creds.json  →  {"account_id": "...", "api_token": "..."}

API Token 所需的最小权限（Account 级）
-------------------------------------
    Workers Scripts : Edit

用法
----
    python deploy.py                 # 上传 Worker + 开 workers.dev 路由
    python deploy.py --subdomain xxx # 顺带创建 workers.dev 子域（若还没有）
    python deploy.py --cron          # 再加定时触发器 23 1 * * *
    python deploy.py --secret-file ../cookie.txt   # 顺带把 Cookie 存成加密变量 COOKIE
    python deploy.py --sign-token <随机串>          # 顺带设置接口鉴权密钥 SIGN_TOKEN
    python deploy.py --all --subdomain xxx --secret-file ../cookie.txt --sign-token <随机串>

关于 --sign-token
-----------------
sign-worker.js 的所有 HTTP 接口都要求请求头 X-Auth 等于变量 SIGN_TOKEN，
否则一律 404（细节见该文件顶部注释）。SIGN_TOKEN 没设置时没有任何请求能通过，
所以**必须在第一次部署时就一起设置**，否则 Worker 会一直返回 404。

生成随机串：
    python -c "import secrets; print(secrets.token_urlsafe(32))"

同一个值要填到 GitHub 仓库 Secret `WORKER_SIGN_TOKEN`
（.github/workflows/daily-sign.yml 会把它放进 X-Auth 请求头）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER_FILE = os.path.join(HERE, "sign-worker.js")
CREDS_FILE = os.path.join(HERE, ".cf_creds.json")
SCRIPT_NAME = "south-sign"
API = "https://api.cloudflare.com/client/v4"


def load_creds() -> tuple[str, str]:
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not (acct and token) and os.path.exists(CREDS_FILE):
        with open(CREDS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        acct = acct or str(d.get("account_id", "")).strip()
        token = token or str(d.get("api_token", "")).strip()
    if not (acct and token):
        sys.exit(f"缺少凭据：请设置 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 环境变量，"
                 f"或创建 {CREDS_FILE}")
    return acct, token


def call(method: str, path: str, acct: str, token: str, body=None,
         ctype: str = "application/json") -> tuple[bool, dict]:
    url = f"{API}/accounts/{acct}{path}"
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": ctype,
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return True, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return False, json.loads(raw)
        except Exception:
            return False, {"errors": [{"message": raw[:400], "code": e.code}]}
    except Exception as e:
        return False, {"errors": [{"message": str(e)}]}


def errors_of(resp: dict) -> str:
    errs = resp.get("errors") or []
    return "; ".join(f"[{e.get('code')}] {e.get('message')}" for e in errs) or str(resp)[:300]


def multipart(fields: dict, files: list) -> tuple[bytes, str]:
    b = "----cfdeploy" + uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode("utf-8")
    for name, filename, ctype, data in files:
        out += (f"--{b}\r\nContent-Disposition: form-data; name=\"{name}\"; "
                f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode("utf-8")
        out += data + b"\r\n"
    out += f"--{b}--\r\n".encode("utf-8")
    return bytes(out), f"multipart/form-data; boundary={b}"


def step(ok: bool, msg: str) -> bool:
    # 用纯 ASCII 标记：原先的 "✓"/"✗" 在 GBK 控制台会抛 UnicodeEncodeError
    # 而**在请求已发出之后**崩掉，导致「部署其实成功了，但脚本退出码非 0」——
    # 只看退出码会误判。改成 ASCII 后这个坑不再存在。
    print(("  [OK] " if ok else "  [!!] ") + msg, flush=True)
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="部署南+签到 Worker 到 Cloudflare")
    ap.add_argument("--subdomain", metavar="NAME", help="创建 workers.dev 子域（若尚无）")
    ap.add_argument("--cron", action="store_true", help="添加定时触发器 23 1 * * *")
    ap.add_argument("--secret-file", metavar="PATH", help="把这个文件的 Cookie 存为加密变量 COOKIE")
    ap.add_argument("--sign-token", metavar="TOKEN",
                    help="设置接口鉴权密钥 SIGN_TOKEN（所有 HTTP 接口都要求 X-Auth 头等于它）")
    ap.add_argument("--ua", metavar="UA", help="把浏览器真实 UA 存为加密变量 UA（这个站按 UA 绑会话，必须设）")
    ap.add_argument("--bark", metavar="URL", help="Bark 设备地址存为加密变量 BARK，如 https://api.day.app/<key>")
    ap.add_argument("--bark-group", metavar="NAME", help="推送分组名（默认 南+签到）")
    ap.add_argument("--bark-ttl", metavar="SEC", help="推送保留秒数（默认 600）")
    ap.add_argument("--all", action="store_true", help="= 上传 + workers.dev 路由")
    ap.add_argument("--show-url", action="store_true", help="只打印 Worker 地址")
    args = ap.parse_args()

    acct, token = load_creds()
    print(f"Account ID : {acct[:6]}...{acct[-4:]}")
    print(f"Worker     : {SCRIPT_NAME}\n")

    # 0. 已经有子域了吗
    ok, resp = call("GET", "/workers/subdomain", acct, token)
    sub = (resp.get("result") or {}).get("subdomain") if ok else None
    if sub:
        print(f"workers.dev 子域：{sub}")
    else:
        print("workers.dev 子域：尚未创建")
        if args.subdomain:
            ok2, r2 = call("PUT", "/workers/subdomain", acct, token, {"subdomain": args.subdomain})
            if not ok2:
                ok2, r2 = call("POST", "/workers/subdomain", acct, token, {"subdomain": args.subdomain})
            step(ok2, f"创建子域 {args.subdomain}" if ok2 else f"创建子域失败：{errors_of(r2)}")
            sub = args.subdomain if ok2 else None
        else:
            print("  （想要 workers.dev 地址请加 --subdomain 名字；只挂自有域名则不需要）")

    if args.show_url:
        if sub:
            print(f"\nURL: https://{SCRIPT_NAME}.{sub}.workers.dev")
        return 0

    # 1. 上传 Worker（ESM 模块）
    with open(WORKER_FILE, "rb") as f:
        js = f.read()
    metadata = json.dumps({"main_module": "sign-worker.js",
                           "compatibility_date": "2026-09-29"})
    body, ctype = multipart(
        {"metadata": metadata},
        [("sign-worker.js", "sign-worker.js", "application/javascript+module", js)],
    )
    ok, resp = call("PUT", f"/workers/scripts/{SCRIPT_NAME}", acct, token, body, ctype)
    if not step(ok, f"上传 sign-worker.js（{len(js)} 字节）" if ok else f"上传失败：{errors_of(resp)}"):
        return 1

    # 2. 打开 workers.dev 路由
    ok, resp = call("POST", f"/workers/scripts/{SCRIPT_NAME}/subdomain", acct, token,
                    {"enabled": True, "previews_enabled": False})
    step(ok, "启用 workers.dev 路由" if ok else f"路由启用失败：{errors_of(resp)}")

    # 3. 定时触发
    if args.cron:
        ok, resp = call("PUT", f"/workers/scripts/{SCRIPT_NAME}/schedules", acct, token,
                        [{"cron": "23 1 * * *"}])
        step(ok, "设置 Cron 23 1 * * *（UTC = 北京时间 09:23）"
             if ok else f"Cron 设置失败：{errors_of(resp)}")

    # 4. Cookie 密钥
    if args.secret_file:
        with open(args.secret_file, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
        ok, resp = call("PUT", f"/workers/scripts/{SCRIPT_NAME}/secrets", acct, token,
                        {"name": "COOKIE", "text": cookie, "type": "secret_text"})
        step(ok, f"写入加密变量 COOKIE（{len(cookie)} 字符）"
             if ok else f"写入 COOKIE 失败：{errors_of(resp)}")

    # 5. UA 密钥（这个站按 UA 绑会话，缺了定时任务必失败）
    if args.ua:
        ok, resp = call("PUT", f"/workers/scripts/{SCRIPT_NAME}/secrets", acct, token,
                        {"name": "UA", "text": args.ua.strip(), "type": "secret_text"})
        step(ok, f"写入加密变量 UA（{len(args.ua.strip())} 字符）"
             if ok else f"写入 UA 失败：{errors_of(resp)}")

    # 5b. 接口鉴权密钥（不设置的话所有 HTTP 接口都返回 404）
    if args.sign_token:
        sign_token = args.sign_token.strip()
        if len(sign_token) < 16:
            step(False, f"SIGN_TOKEN 太短（{len(sign_token)} 字符），建议至少 16；"
                        f"已跳过，Worker 会继续拒绝所有 HTTP 请求")
        else:
            ok, resp = call("PUT", f"/workers/scripts/{SCRIPT_NAME}/secrets", acct, token,
                            {"name": "SIGN_TOKEN", "text": sign_token, "type": "secret_text"})
            step(ok, f"写入加密变量 SIGN_TOKEN（{len(sign_token)} 字符）"
                 if ok else f"写入 SIGN_TOKEN 失败：{errors_of(resp)}")

    # 6. Bark 推送地址 + 可选分组/TTL
    for name, val in (("BARK", args.bark), ("BARK_GROUP", args.bark_group),
                      ("BARK_TTL", args.bark_ttl)):
        if not val:
            continue
        ok, resp = call("PUT", f"/workers/scripts/{SCRIPT_NAME}/secrets", acct, token,
                        {"name": name, "text": str(val).strip(), "type": "secret_text"})
        shown = val if name != "BARK" else "https://api.day.app/***"
        step(ok, f"写入加密变量 {name} = {shown}"
             if ok else f"写入 {name} 失败：{errors_of(resp)}")

    if sub:
        print(f"\nWorker 地址：https://{SCRIPT_NAME}.{sub}.workers.dev")
        if args.sign_token and len(args.sign_token.strip()) >= 16:
            print(f"自测：curl -H \"X-Auth: $SIGN_TOKEN\" "
                  f"\"https://{SCRIPT_NAME}.{sub}.workers.dev/probe\"")
        else:
            print("⚠️ 本次没有设置 SIGN_TOKEN，Worker 会拒绝所有 HTTP 请求（一律 404）。")
            print("   重新部署时加上：--sign-token <随机串>，并把同一个值填进")
            print("   GitHub 仓库 Secret WORKER_SIGN_TOKEN。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
