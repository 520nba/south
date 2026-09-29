// ============================================================================
// 南+ / n+ 签到 Worker
//
// 用途有两个，顺序很重要 —— 先诊断，再决定要不要拿它当正式方案：
//   ① 从 Cloudflare 边缘出口实测：你的 Cookie 在 CF 的 IP 上认不认。
//      认  → 之前的失败是「机场节点 IP 被拉黑」，Worker 直连可行，它就是成品；
//      不认 → 确认是「会话绑定登录 IP」，Worker 执行这条路放弃，
//             改为让 Worker 只当 Cron 调度器去触发家里的常开设备。
//   ② 若 ① 通过，加个 Cron Trigger 即可每天自动跑。
//
// ── 部署（全程网页，不用装 CLI）────────────────────────────────────────────
//   1. dash.cloudflare.com → 左侧 Workers & Pages → Create application
//      → Create Worker → 起个名（如 south-sign）→ Deploy
//      （首次会提示启用 workers.dev 子域，免费）
//   2. 点 Edit code，把本文件**全部内容**替换掉模板里的 export default{...} → Deploy
//   3. 拿到地址 https://<名字>.<子域>.workers.dev
//
// ── 接口 ───────────────────────────────────────────────────────────────────
//   GET /            用法说明
//   GET /probe       无凭据探测四个镜像（出口 IP / 状态码 / CF 拦截 / 登录态）
//   GET /sign        执行签到
//   GET /sign?dry=1  只校验登录态，不提交任务
//   传 Cookie 两种方式（两个接口都支持）：
//     · 请求头 X-Cookie: eb9e6_winduser=...   临时测试用这个最省事
//     · Worker 变量 COOKIE（Settings → Variables，建议勾加密）  正式用法
//
// ── 定时（确认可用后再加）──────────────────────────────────────────────────
//   Settings → Triggers → Cron Triggers 填 23 1 * * *（UTC = 北京时间 09:23）
//   并确保已设置 COOKIE 变量。
// ============================================================================

const MIRRORS = [
  'https://www.north-plus.net',
  'https://www.south-plus.net',
  'https://www.summer-plus.net',
  'https://www.level-plus.net',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const CF_MARKERS = ['Just a moment', 'cf-browser-verification', '__cf_chl',
                    'Attention Required', 'Checking your browser'];

const TASKS = [
  { cid: 15, name: '日常任务' },
  { cid: 14, name: '周常任务' },
];

function looksCF(text) {
  const head = text.slice(0, 4000);
  return CF_MARKERS.some((m) => head.includes(m));
}

function titleOf(text) {
  const m = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

function stripCdata(text) {
  const m = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : text.replace(/<[^>]+>/g, '')).trim();
}

function judgeLogin(text) {
  if (looksCF(text)) return '无法判定（被 CF 拦截）';
  if (text.includes('name="pwuser"') || text.includes('您没有登录')) return '未登录';
  return '已登录';
}

async function httpGet(url, cookie) {
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': url,
  };
  if (cookie) headers['Cookie'] = cookie;
  const t0 = Date.now();
  const res = await fetch(url, { headers, redirect: 'manual' });
  const text = await res.text();
  return {
    status: res.status,
    ms: Date.now() - t0,
    bytes: text.length,
    text,
    setCookie: res.headers.get('set-cookie') ? '有' : '无',
  };
}

async function egressIP() {
  for (const u of ['https://api.ipify.org', 'https://ipv4.icanhazip.com']) {
    try {
      const r = await fetch(u);
      const ip = (await r.text()).trim();
      if (/^[0-9a-fA-F:.]{7,45}$/.test(ip)) return ip;
    } catch (e) { /* 试下一个 */ }
  }
  return 'unknown';
}

async function doProbe(cookie) {
  const ip = await egressIP();
  const rows = [];
  for (const base of MIRRORS) {
    try {
      const r = await httpGet(base + '/plugin.php?H_name=tasks.html', cookie);
      rows.push({
        镜像: base,
        Code: r.status,
        字节: r.bytes,
        耗时ms: r.ms,
        CF拦截: looksCF(r.text),
        登录态: judgeLogin(r.text),
        页面标题: titleOf(r.text),
        片段: r.text.replace(/\s+/g, ' ').slice(0, 120),
        服务端下发新Cookie: r.setCookie,
      });
    } catch (e) {
      rows.push({ 镜像: base, 异常: String(e) });
    }
  }
  return {
    Worker出口IP: ip,
    Cookie: cookie ? `已传入（${cookie.length} 字符）` : '未传入（只做可达性探测）',
    结果: rows,
  };
}

// 直打真实 ajax 鉴权接口，绕开页面判断。
// cid 传一个不存在的任务号即可做「零副作用」的鉴权探针：
//   未登录 → 「您还没有登录或注册」；已登录 → 会变成任务不存在之类的文案。
async function doAjax(cookie, action, cid, mirrorIdx) {
  const idx = Math.min(Math.max(mirrorIdx | 0, 0), MIRRORS.length - 1);
  const base = MIRRORS[idx];
  const url = `${base}/plugin.php?H_name=tasks&action=ajax&actions=${action}`
            + `&cid=${cid}&nowtime=${Date.now()}`;
  const r = await httpGet(url, cookie);
  return {
    url,
    Worker出口IP: await egressIP(),
    Code: r.status,
    字节: r.bytes,
    原始: r.text.slice(0, 300),
    CDATA: stripCdata(r.text).slice(0, 200),
  };
}

async function doSign(cookie, dryRun) {
  if (!cookie) {
    return { ok: false, reason: '没有拿到 Cookie：请传 X-Cookie 请求头，或设置 COOKIE 变量' };
  }
  const probe = await doProbe(cookie);
  const usable = probe.结果.find((r) => !r.异常 && r.CF拦截 === false && r.登录态 === '已登录');

  if (!usable) {
    return {
      ok: false,
      reason: '没有任何镜像处于「已登录」状态，未提交任何任务',
      Worker出口IP: probe.Worker出口IP,
      结果: probe.结果,
    };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, 使用镜像: usable.镜像, Worker出口IP: probe.Worker出口IP };
  }

  const base = usable.镜像;
  const results = [];
  for (const t of TASKS) {
    const job = await httpGet(
      `${base}/plugin.php?H_name=tasks&action=ajax&actions=job&cid=${t.cid}&nowtime=${Date.now()}`, cookie);
    await new Promise((r) => setTimeout(r, 1600));
    const reward = await httpGet(
      `${base}/plugin.php?H_name=tasks&action=ajax&actions=job2&cid=${t.cid}&nowtime=${Date.now()}`, cookie);
    results.push({
      任务: t.name,
      cid: t.cid,
      申请任务: stripCdata(job.text).slice(0, 120),
      领取奖励: stripCdata(reward.text).slice(0, 120),
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: true, Worker出口IP: probe.Worker出口IP, 使用镜像: base, 结果: results };
}

function cookieOf(env, request) {
  const fromHeader = request && request.headers.get('X-Cookie');
  return (fromHeader || (env && env.COOKIE) || '').trim();
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const USAGE = `南+ 签到 Worker

  GET /probe                无凭据探测四个镜像
  GET /sign                 执行签到
  GET /sign?dry=1           只校验登录态，不提交

传 Cookie：
  · 请求头 X-Cookie: eb9e6_winduser=...
  · 或 Worker 变量 COOKIE（Settings → Variables）

定时：
  Settings → Triggers → Cron Triggers 填  23 1 * * *
`;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const cookie = cookieOf(env, request);

    if (path === '/') {
      return new Response(USAGE, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (path === '/probe') return json(await doProbe(cookie));
    if (path === '/ajax') {
      const q = new URL(request.url).searchParams;
      const action = (q.get('actions') || 'job').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
      const cid = (q.get('cid') || '99999').replace(/[^0-9]/g, '').slice(0, 6) || '99999';
      return json(await doAjax(cookie, action, cid, Number(q.get('mirror') || 0)));
    }
    if (path === '/sign') {
      const dry = new URL(request.url).searchParams.get('dry') === '1';
      return json(await doSign(cookie, dry));
    }
    return new Response('未知路径，试试 / 或 /probe\n', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(doSign(cookieOf(env, null), false));
  },
};
