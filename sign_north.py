#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
n+ / 南+ 论坛「社区任务」自动签到（北+ north-plus.net 与南+ south-plus.net 同源，任务插件通用）

原理
----
南+ 是 PHPWind 内核，签到走的是任务插件的两个 ajax 接口：

    申请任务： plugin.php?H_name=tasks&action=ajax&actions=job&cid=<任务ID>
    完成领奖： plugin.php?H_name=tasks&action=ajax&actions=job2&cid=<任务ID>

返回体是 XML 包 CDATA 的文本，例：
    <?xml version="1.0" encoding="utf-8"?><ajax><![CDATA[您还没有登录或注册...]]></ajax>

日常任务 cid=15，周常任务 cid=14（脚本会自动从任务页抓取，抓不到才用默认值）。

Cookie 怎么拿
-------------
1. Chrome 登录论坛，打开 插件页 plugin.php?H_name-tasks.html
2. F12 → Network → 刷新 → 点第一个 plugin.php 请求 → Headers → Request Headers
3. 找到 Cookie: 一行，整段复制（形如 eb9e6_winduser=xxx; eb9e6_ck_info=xxx; ...）
4. 存进本目录 cookie.txt，或直接执行：
       python sign_north.py --set-cookie "粘贴到这里"

用法
----
    python sign_north.py                    # 执行签到
    python sign_north.py --check            # 只检测 Cookie 登录态、列出任务
    python sign_north.py --probe            # 体检：出口 IP + 可达性/CF/登录态，不需要 Cookie
    python sign_north.py --debug            # 打印原始返回，排错用
    python sign_north.py --set-cookie "..." # 写入 cookie.txt
    python sign_north.py --install-task 09:00   # 注册 Windows 每日计划任务
    python sign_north.py --remove-task          # 删除计划任务
    python sign_north.py --strict               # 未识别的返回文案也判失败

GitHub Actions
--------------
仓库里 .github/workflows/daily-sign.yml 负责每天定时跑，Cookie 存仓库 Secrets 的
NORTH_COOKIE。机房 IP 容易被 Cloudflare 拦，脚本会明确报出来；被拦时配 Secrets 的
NORTH_PROXY 走代理即可（脚本不吃环境变量，显式读 NORTH_PROXY）。

仅用标准库，不需要 pip 装任何东西。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
COOKIE_PATH = os.path.join(BASE_DIR, "cookie.txt")
LOG_PATH = os.path.join(BASE_DIR, "sign.log")
TASK_NAME = "north_plus_sign"

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

# 同一套论坛程序的镜像域名，主站被 Cloudflare 拦了会依次重试
DEFAULT_BASES = [
    "https://www.north-plus.net",
    "https://www.south-plus.net",
    "https://www.summer-plus.net",
    "https://www.level-plus.net",
]

DEFAULT_CONFIG = {
    "base_url": "https://www.north-plus.net",
    "fallback_urls": DEFAULT_BASES[1:],
    "cookie": "",
    "user_agent": DEFAULT_UA,
    "timeout": 20,
    "method": "GET",          # 接口用 GET，某些镜像需要 POST 时可改
    "retries": 3,             # 单请求失败重试次数（含 Cloudflare 403 / 5xx）
    "http_proxy": "",         # 形如 http://user:pass@host:port，GitHub 上被 CF 拦时用
    "delay_between": 2.0,     # 申请任务 → 领奖励之间的等待秒数
    "task_gap": 2.0,          # 两个任务之间的间隔
    "auto_discover": True,    # 从任务页自动解析 cid
    "tasks": [                # 兜底任务表（自动发现失败时使用）
        {"cid": 15, "name": "日常任务"},
        {"cid": 14, "name": "周常任务"},
    ],
    "notify": {
        "enable": False,
        "serverchan_key": "",  # https://sct.ftqq.com 的 SendKey
        "bark_url": "",        # https://api.day.app/<key>
    },
}

CF_MARKERS = ("Just a moment", "cf-browser-verification", "Attention Required",
              "__cf_chl", "Checking your browser")


def looks_like_cf(text: str) -> bool:
    """判断响应是不是 Cloudflare 的挑战页 / 拦截页，而不是论坛的真实页面。"""
    head = text[:4000]
    return any(m in head for m in CF_MARKERS)


def redact(url: str) -> str:
    """打日志时把代理里的账号密码抹掉。"""
    return re.sub(r"//[^@/]+@", "//***@", url)


def cf_evidence(text: str) -> str:
    """从拦截页里挖一点可核对的证据：命中的标记 + 页面标题。"""
    hit = next((m for m in CF_MARKERS if m in text[:4000]), "")
    m = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
    title = re.sub(r"\s+", " ", m.group(1)).strip()[:60] if m else ""
    parts = []
    if hit:
        parts.append(f"命中标记「{hit}」")
    if title:
        parts.append(f"页面标题「{title}」")
    return "；".join(parts)


# --------------------------------------------------------------------------- #
# 配置 / 日志
# --------------------------------------------------------------------------- #
def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                user_cfg = json.load(f)
            for k, v in user_cfg.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except Exception as exc:                                   # noqa: BLE001
            log(f"config.json 解析失败，改用默认配置：{exc}")
    else:
        save_config(cfg)
    return cfg


def save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def resolve_cookie(cfg: dict) -> str:
    """优先级：环境变量 > cookie.txt > config.json。"""
    for env_key in ("NORTH_COOKIE", "SOUTH_COOKIE", "SOUTHPLUS_COOKIE"):
        if os.environ.get(env_key, "").strip():
            return clean_cookie(os.environ[env_key])
    if os.path.exists(COOKIE_PATH):
        with open(COOKIE_PATH, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        if raw:
            return clean_cookie(raw)
    return clean_cookie(cfg.get("cookie", ""))


def clean_cookie(raw: str) -> str:
    """容忍粘贴时带上 'Cookie: ' 前缀、换行、末尾多余分号。"""
    raw = raw.strip()
    raw = re.sub(r"^\s*cookie\s*:\s*", "", raw, flags=re.I)
    raw = raw.replace("\r", " ").replace("\n", " ")
    raw = re.sub(r"\s+", " ", raw).strip(" ;")
    return raw


def log(msg: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def make_opener(cfg: dict) -> urllib.request.OpenerDirector:
    """显式装 ProxyHandler 而不是靠环境变量，本地和 CI 行为一致。"""
    ctx = ssl.create_default_context()
    handlers = [urllib.request.HTTPSHandler(context=ctx)]
    proxy = (cfg.get("http_proxy") or os.environ.get("NORTH_PROXY") or "").strip()
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        log(f"已启用代理：{redact(proxy)}")
    return urllib.request.build_opener(*handlers)


def http_get(opener, url: str, cfg: dict, cookie: str) -> tuple[int, str]:
    headers = {
        "User-Agent": cfg["user_agent"],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": url.split("plugin.php")[0] + "plugin.php?H_name-tasks.html",
        "Connection": "close",
    }
    if cookie:
        headers["Cookie"] = cookie

    attempts = max(1, int(cfg.get("retries", 3)))
    last: tuple[int, str] = (0, "")
    for i in range(attempts):
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with opener.open(req, timeout=cfg["timeout"]) as resp:
                body = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    import gzip
                    body = gzip.decompress(body)
                return resp.status, body.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            last = (e.code, e.read().decode("utf-8", errors="replace"))
            # 4xx（除 403/429）是确定性错误，重试没意义
            if e.code not in (403, 429, 500, 502, 503, 504):
                return last
        except Exception as exc:                                   # noqa: BLE001
            last = (0, f"__EXC__{type(exc).__name__}: {exc}")
        if i < attempts - 1:
            time.sleep(1.5 * (i + 1))                              # 退避
    return last


def strip_cdata(text: str) -> str:
    """把 ajax 的 XML CDATA 剥成纯文本。"""
    m = re.search(r"<!\[CDATA\[(.*?)\]\]>", text, re.S)
    if m:
        return m.group(1).strip()
    plain = re.sub(r"<\?xml[^>]*\?>", "", text)
    plain = re.sub(r"<[^>]+>", "", plain)
    return plain.strip()


def classify(msg: str) -> str:
    """把服务端文案归类，便于统一判断。"""
    low = msg.lower()
    if any(k in msg for k in ("没有登录", "未登录", "不能使用此功能", "请先登录", "您还没有登录")):
        return "not_login"
    if "success" in low or "成功" in msg:
        return "ok"
    if any(k in msg for k in ("已经领取", "已领取", "已经完成", "已完成", "已申请",
                              "领取过", "完成过", "已经申请", "重复")):
        return "done"
    if any(k in msg for k in ("冷却", "间隔", "时间未到", "还不够")):
        return "cooldown"
    return "unknown"


# --------------------------------------------------------------------------- #
# 业务
# --------------------------------------------------------------------------- #
def pick_base(opener, cfg, cookie, debug=False) -> tuple[str | None, bool]:
    """依次试主站和镜像，返回 (可用地址, 是否被 Cloudflare 全线拦截)。"""
    candidates = [cfg["base_url"]] + [u for u in cfg.get("fallback_urls", [])
                                     if u and u != cfg["base_url"]]
    cf_hits = 0
    for base in candidates:
        url = base.rstrip("/") + "/plugin.php?H_name=tasks.html"
        status, text = http_get(opener, url, cfg, cookie)
        if debug:
            log(f"探活 {base} -> HTTP {status}, {len(text)} bytes")
        if text.startswith("__EXC__"):
            log(f"探活失败 {base}：{text[7:]}")
            continue
        if looks_like_cf(text) or (status == 403 and len(text) < 20000):
            log(f"{base} 被 Cloudflare 拦截（HTTP {status}）")
            cf_hits += 1
            continue
        if status == 200 and len(text) > 500:
            return base, False
        log(f"{base} 响应异常（HTTP {status}），换镜像…")
    return None, cf_hits == len(candidates)


def detect_login(text: str) -> bool:
    """能否从页面确认「已登录」。

    注意：Cloudflare 挑战页里既没有 pwuser 也没有「您没有登录」，
    早期版本因此把它误判成「已登录」，这里必须先排除掉。
    """
    if looks_like_cf(text):
        return False
    if 'name="pwuser"' in text or "您没有登录" in text:
        return False
    return True


def discover_tasks(text: str, cfg) -> list[dict]:
    """从任务页里解析任务 cid；解不出就用兜底表。"""
    if not cfg.get("auto_discover", True):
        return cfg["tasks"]

    found: dict[int, str] = {}
    # 1) 改写后的链接： H_name=tasks-actions-job-cid-15
    for m in re.finditer(r"cid[-=](\d{1,4})", text):
        cid = int(m.group(1))
        if 0 < cid < 1000:
            found.setdefault(cid, "")
    # 2) 元素 id 形如 p_15 / both_15（旧版模板）
    for m in re.finditer(r'id="(?:p|both)_(\d{1,4})"', text):
        found.setdefault(int(m.group(1)), "")
    # 3) 顺带抓一下任务名，抓不到就留空
    for cid in list(found):
        m = re.search(r"cid[-=]%d[^>]{0,200}?>([^<>]{2,20})</a>" % cid, text, re.S)
        if m:
            found[cid] = re.sub(r"\s+", " ", m.group(1)).strip()

    if not found:
        log("未能从页面解析出任务 ID，回退到内置任务表")
        return cfg["tasks"]

    tasks = [{"cid": c, "name": n or f"任务#{c}"} for c, n in sorted(found.items())]
    log("页面解析到任务：" + "、".join(f"{t['name']}(cid={t['cid']})" for t in tasks))
    return tasks


def call_ajax(opener, base, cfg, cookie, action, cid, debug=False) -> tuple[str, str]:
    url = (f"{base}/plugin.php?H_name=tasks&action=ajax&actions={action}"
           f"&cid={cid}&nowtime={int(time.time() * 1000)}")
    status, text = http_get(opener, url, cfg, cookie)
    if debug:
        log(f"  [{action} cid={cid}] HTTP {status} RAW: {text[:300]}")
    if text.startswith("__EXC__"):
        return "error", text[7:]
    if looks_like_cf(text):
        return "cf", f"被 Cloudflare 拦截（HTTP {status}）"
    msg = strip_cdata(text)
    return classify(msg), msg


def public_ip(cfg) -> str:
    """尽力而为地查当前出口 IP；查不到返回 unknown。"""
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip",
                "https://ipv4.icanhazip.com"):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": cfg["user_agent"]})
            with urllib.request.urlopen(req, timeout=8) as r:
                ip = r.read().decode("utf-8", "replace").strip()
            if re.fullmatch(r"[0-9a-fA-F:.]{7,45}", ip):
                return ip
        except Exception:                                          # noqa: BLE001
            continue
    return "unknown"


def run_probe(cfg, cookie: str, debug=False) -> int:
    """体检：报出口 IP + 各站点可达性/CF 拦截/登录态。不需要 Cookie 也能跑。"""
    opener = make_opener(cfg)
    ip = public_ip(cfg)
    print(f"出口 IP        : {ip}")
    print(f"User-Agent     : {cfg['user_agent'][:70]}")
    print(f"Cookie         : {'已提供，%d 字符' % len(cookie) if cookie else '未提供（只做可达性探测）'}")
    print()
    print("| 站点 | HTTP | 字节 | CF拦截 | 登录态 |")
    print("| --- | --- | --- | --- | --- |")
    bases = [cfg["base_url"]] + [u for u in cfg.get("fallback_urls", [])
                                 if u and u != cfg["base_url"]]
    notes = []
    for base in bases:
        status, text = http_get(
            opener, base.rstrip("/") + "/plugin.php?H_name=tasks.html", cfg, cookie)
        if text.startswith("__EXC__"):
            print(f"| {base} | 异常 | - | - | {text[7:50]} |")
            continue
        blocked = looks_like_cf(text)
        cf = "**是**" if blocked else "否"
        if blocked:
            # 被拦截时无法判定登录态，别硬猜成「已登录」
            login = "无法判定"
            ev = cf_evidence(text)
            if ev:
                notes.append(f"- {base} → {ev}")
        else:
            login = "已登录" if detect_login(text) else "未登录"
        print(f"| {base} | {status} | {len(text)} | {cf} | {login} |")
    if notes:
        print()
        print("拦截证据：")
        print("\n".join(notes))
    print()
    print("判读方法：")
    print("  1. 出口 IP 和你浏览器当前的公网 IP 不一致 → 会话会被 PHPWind 判为异地，")
    print("     表现为「Cookie 明明有效却提示没有登录」。")
    print("  2. CF拦截=是 → 这个 IP 被 Cloudflare 挑战页挡住，纯 HTTP 客户端过不去。")
    print("  3. CF拦截=否 但登录态仍为「未登录」→ 就是第 1 条。")
    return 0


def run_sign(cfg, cookie, debug=False, check_only=False, strict=False) -> int:
    opener = make_opener(cfg)
    base, all_cf = pick_base(opener, cfg, cookie, debug)
    if not base:
        if all_cf:
            log("所有站点都被 Cloudflare 拦截 —— GitHub Actions 上最常见的失败原因，"
                "机房 IP 在 CF 那里信誉分太低。")
            log("出路一：配 secrets.NORTH_PROXY 走代理；"
                "出路二：改用本机计划任务 python sign_north.py --install-task 09:00")
        else:
            log("所有镜像都不可用，签到中止")
        return 2
    log(f"使用站点：{base}")

    # 页面探测：登录态 + 任务清单
    _, page = http_get(opener, f"{base}/plugin.php?H_name=tasks.html", cfg, cookie)
    if looks_like_cf(page):
        log(f"任务页被 Cloudflare 拦截，无法校验登录态 —— 机房 / 代理 IP 的典型症状。（{cf_evidence(page)}）")
        return 2
    if not detect_login(page):
        log("Cookie 未通过登录校验（返回的是登录表单）。若你此刻在浏览器里明明是登录状态，"
            "多半是会话与登录 IP 绑定，异地重放会被 PHPWind 判为未登录。")
        return 3

    tasks = discover_tasks(page, cfg)
    if check_only:
        log("登录态正常 ✓  任务解析完成，--check 模式不做提交。")
        return 0

    # 检测通过后随机抖动，避免每天固定秒数打卡
    time.sleep(random.uniform(0.5, 2.5))

    results = []
    for task in tasks:
        cid, name = task["cid"], task["name"]
        log(f"—— {name} (cid={cid}) ——")
        s1, m1 = call_ajax(opener, base, cfg, cookie, "job", cid, debug)
        if s1 == "not_login":
            log(f"  {name}：登录态失效，中止。")
            return 3
        log(f"  申请任务：{m1}")
        if s1 in ("error", "cf"):
            results.append((name, "被拦截" if s1 == "cf" else "失败", m1))
            continue

        # 申请过了也要走一遍领奖，防止上次只申请没领
        time.sleep(cfg["delay_between"])
        s2, m2 = call_ajax(opener, base, cfg, cookie, "job2", cid, debug)
        if s2 == "not_login":
            log(f"  {name}：登录态失效，中止。")
            return 3
        log(f"  领取奖励：{m2}")

        if s2 == "ok":
            results.append((name, "成功", m2))
        elif s2 == "done" or s1 in ("done", "cooldown"):
            results.append((name, "已完成", m1 if s1 in ("done", "cooldown") else m2))
        elif s2 == "cf":
            results.append((name, "被拦截", m2))
        elif s2 == "unknown":
            results.append((name, "未知", m2))
        else:
            results.append((name, "失败", m2))
        time.sleep(cfg["task_gap"])

    log("===== 签到结果 =====")
    for name, state, msg in results:
        log(f"  {name}: {state} | {msg[:80]}")

    bad = [r for r in results if r[1] in ("失败", "被拦截")]
    unknown = [r for r in results if r[1] == "未知"]
    if bad:
        code = 1
        log(f"存在失败项 {len(bad)} 个，退出码 1")
    elif unknown and strict:
        code = 1
        log(f"有 {len(unknown)} 个任务返回了无法识别的文案（--strict 下视为失败）。"
            "把上面原文发我，我按实际文案收紧判断。")
    elif unknown:
        code = 0
        log(f"有 {len(unknown)} 个任务返回未识别的文案，已按「不打扰」处理（退出码 0）。"
            "想让它算失败请加 --strict。")
    else:
        code = 0
    notify(cfg, results, base, code == 0)
    return code


# --------------------------------------------------------------------------- #
# 通知（可选）
# --------------------------------------------------------------------------- #
def notify(cfg, results, base, ok) -> None:
    n = cfg.get("notify") or {}
    if not n.get("enable"):
        return
    title = f"n+ 签到 {'成功' if ok else '异常'}"
    body = "\n".join(f"{name}: {state} | {msg}" for name, state, msg in results)
    try:
        if n.get("serverchan_key"):
            data = urllib.parse.urlencode({"title": title, "desp": body}).encode()
            urllib.request.urlopen(
                urllib.request.Request(
                    f"https://sctapi.ftqq.com/{n['serverchan_key']}.send", data=data),
                timeout=15).read()
        if n.get("bark_url"):
            url = n["bark_url"].rstrip("/") + "/" + urllib.parse.quote(title) + "/" + urllib.parse.quote(body)
            urllib.request.urlopen(url, timeout=15).read()
        log("通知已推送")
    except Exception as exc:                                       # noqa: BLE001
        log(f"通知推送失败：{exc}")


# --------------------------------------------------------------------------- #
# 计划任务
# --------------------------------------------------------------------------- #
def install_task(at_time: str) -> None:
    if os.name != "nt":
        print("--install-task 只在 Windows 上有效；其它平台请用 crontab，"
              "或直接用 .github/workflows 里的定时任务。")
        return
    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    exe = pyw if os.path.exists(pyw) else sys.executable
    script = os.path.abspath(__file__)
    cmd = (f'schtasks /Create /TN "{TASK_NAME}" /TR "\\"{exe}\\" \\"{script}\\"" '
           f'/SC DAILY /ST {at_time} /F')
    print("执行：" + cmd)
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        out = (r.stdout or "") + (r.stderr or "")
        print(out.strip())
        if r.returncode == 0:
            print(f"\n已注册计划任务「{TASK_NAME}」，每天 {at_time} 自动签到。")
        else:
            print("\n注册失败，请手动在管理员终端里执行上面那条命令。")
    except Exception as exc:                                       # noqa: BLE001
        print(f"注册失败：{exc}\n请手动执行：\n{cmd}")


def remove_task() -> None:
    cmd = f'schtasks /Delete /TN "{TASK_NAME}" /F'
    print("执行：" + cmd)
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        print(((r.stdout or "") + (r.stderr or "")).strip())
    except Exception as exc:                                       # noqa: BLE001
        print(f"删除失败：{exc}\n请手动执行：{cmd}")


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(
        description="n+/南+ 论坛社区任务自动签到",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python sign_north.py --set-cookie \"eb9e6_winduser=...\"\n"
               "  python sign_north.py --check\n"
               "  python sign_north.py --install-task 09:00")
    ap.add_argument("--check", action="store_true", help="只检测 Cookie 登录态与任务列表，不提交")
    ap.add_argument("--probe", action="store_true",
                    help="体检：出口 IP + 各站点可达性/CF 拦截/登录态，不需要 Cookie")
    ap.add_argument("--ip", action="store_true", help="只打印当前出口 IP")
    ap.add_argument("--debug", action="store_true", help="打印接口原始返回")
    ap.add_argument("--strict", action="store_true",
                    help="未识别的返回文案也视为失败（默认放过，避免误报）")
    ap.add_argument("--set-cookie", metavar="COOKIE", help="把 Cookie 写入 cookie.txt")
    ap.add_argument("--base", metavar="URL", help="临时指定站点，如 https://www.south-plus.net")
    ap.add_argument("--install-task", metavar="HH:MM", help="注册 Windows 每日计划任务")
    ap.add_argument("--remove-task", action="store_true", help="删除计划任务")
    args = ap.parse_args()

    if args.set_cookie:
        with open(COOKIE_PATH, "w", encoding="utf-8") as f:
            f.write(clean_cookie(args.set_cookie))
        print(f"Cookie 已写入 {COOKIE_PATH}")
        return 0
    if args.remove_task:
        remove_task()
        return 0
    if args.install_task:
        install_task(args.install_task)
        return 0

    cfg = load_config()
    if args.base:
        cfg["base_url"] = args.base
    if args.ip:
        print(public_ip(cfg))
        return 0
    cookie = resolve_cookie(cfg)
    if args.probe:
        return run_probe(cfg, cookie, debug=args.debug)
    if not cookie:
        log("未找到 Cookie。本地请执行： python sign_north.py --set-cookie \"<浏览器里的Cookie>\"；"
            "GitHub Actions 上请把 Cookie 存成仓库 Secrets 里的 NORTH_COOKIE。")
        return 4
    return run_sign(cfg, cookie, debug=args.debug,
                    check_only=args.check, strict=args.strict)


if __name__ == "__main__":
    sys.exit(main())
