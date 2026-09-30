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
//   全部接口都要求请求头 X-Auth 等于 Worker 变量 SIGN_TOKEN，否则一律 404。
//   GET /            用法说明
//   GET /probe       探测四个镜像（出口 IP / 状态码 / CF 拦截 / 登录态）
//   GET /sign        执行签到
//   GET /sign?dry=1  只校验登录态，不提交任务
//   传 Cookie 两种方式（两个接口都支持）：
//     · 请求头 X-Cookie: eb9e6_winduser=...   临时测试用这个最省事
//     · Worker 变量 COOKIE（Settings → Variables，建议勾加密）  正式用法
//
//   示例：
//     curl -H "X-Auth: $SIGN_TOKEN" https://<名字>.<子域>.workers.dev/sign
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

// ⚠️ 这个站把会话绑定在 User-Agent 上：UA 不符 → 一律回「您还没有登录」。
// 默认值必须是抓 Cookie 那个浏览器的真实 UA（用 https://httpbin.org/user-agent 读）。
// 与浏览器换版本（Chrome 升级）后要同步改，或用 UA 变量覆盖。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const CF_MARKERS = ['Just a moment', 'cf-browser-verification', '__cf_chl',
                    'Attention Required', 'Checking your browser'];

const TASKS = [
  { cid: 15, name: '日常任务' },
  { cid: 14, name: '周常任务' },
];

// Bark 推送。BARK 变量存设备地址（如 https://api.day.app/<key>），不写进源码。
// group / ttl 可用 BARK_GROUP / BARK_TTL 变量覆盖。
const BARK_GROUP = '南+签到';
const BARK_TTL = 600;

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

async function httpGet(url, cookie, ua) {
  const headers = {
    'User-Agent': ua || UA,
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

async function doProbe(cookie, ua) {
  const ip = await egressIP();
  const rows = [];
  for (const base of MIRRORS) {
    try {
      const r = await httpGet(base + '/plugin.php?H_name=tasks.html', cookie, ua);
      const ap = await authProbe(base, cookie, ua);
      rows.push({
        镜像: base,
        Code: r.status,
        字节: r.bytes,
        耗时ms: r.ms,
        CF拦截: looksCF(r.text),
        页面登录态: judgeLogin(r.text),
        鉴权: ap.authed ? '✅ 已登录' : '❌ 未登录',
        鉴权原文: ap.msg.slice(0, 60),
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
    UserAgent: ua || UA,
    结果: rows,
  };
}

// 直打真实 ajax 鉴权接口，绕开页面判断。
// cid 传一个不存在的任务号即可做「零副作用」的鉴权探针：
//   未登录 → 「您还没有登录或注册」；已登录 → 会变成任务不存在之类的文案。
async function doAjax(cookie, action, cid, mirrorIdx, ua) {
  const idx = Math.min(Math.max(mirrorIdx | 0, 0), MIRRORS.length - 1);
  const base = MIRRORS[idx];
  const url = `${base}/plugin.php?H_name=tasks&action=ajax&actions=${action}`
            + `&cid=${cid}&nowtime=${Date.now()}`;
  const r = await httpGet(url, cookie, ua);
  return {
    url,
    Worker出口IP: await egressIP(),
    UserAgent: ua || UA,
    Code: r.status,
    字节: r.bytes,
    原始: r.text.slice(0, 300),
    CDATA: stripCdata(r.text).slice(0, 200),
  };
}

async function doSign(env, cookie, dryRun, ua) {
  if (!cookie) {
    return { ok: false, reason: '没有拿到 Cookie：请传 X-Cookie 请求头，或设置 COOKIE 变量' };
  }
  // 用鉴权探针挑镜像：CF 边缘拿到的任务页可能是别的实例，页面判断不可靠
  const probes = [];
  for (const base of MIRRORS) {
    try {
      probes.push(await authProbe(base, cookie, ua));
    } catch (e) {
      probes.push({ base, msg: String(e), authed: false });
    }
  }
  const usable = probes.find((p) => p.authed);

  if (!usable) {
    const reason = '所有镜像都判为未登录。若 Cookie 刚抓不久，检查 UA 是否与抓 Cookie 的浏览器一致';
    const bark = await notifyBark(env, '南+ 签到失败',
      `${reason}\n` + probes.map((p) => `${p.base}: ${p.msg}`).join('\n'));
    return { ok: false, reason, bark, 鉴权探针: probes };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, 使用镜像: usable.base, 鉴权原文: usable.msg, 鉴权探针: probes };
  }

  const base = usable.base;
  const results = [];
  for (const t of TASKS) {
    const job = await httpGet(
      `${base}/plugin.php?H_name=tasks&action=ajax&actions=job&cid=${t.cid}&nowtime=${Date.now()}`, cookie, ua);
    await new Promise((r) => setTimeout(r, 1600));
    const reward = await httpGet(
      `${base}/plugin.php?H_name=tasks&action=ajax&actions=job2&cid=${t.cid}&nowtime=${Date.now()}`, cookie, ua);
    results.push({
      任务: t.name,
      cid: t.cid,
      申请任务: stripCdata(job.text).slice(0, 120),
      领取奖励: stripCdata(reward.text).slice(0, 120),
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
  const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const lines = results.map((r) => {
    const raw = String(r.领取奖励 || r.申请任务 || '');
    const got = /^success/.test(raw);
    return `${got ? '✓' : '·'} ${r.任务}：${raw.replace(/^success\s*/, '')}`;
  });
  // 只有至少一个任务真的「success」才算有变化，否则如实说无变化（冷却期重复跑就是这种）
  const changed = results.some((r) => /^success/.test(String(r.领取奖励 || '')));
  const bark = await notifyBark(env, changed ? '南+ 签到完成' : '南+ 签到（本次无变化）',
    [`${bj}（北京）`, `镜像 ${base.replace('https://www.', '')}`, '', ...lines].join('\n'));

  return {
    ok: true,
    Worker出口IP: await egressIP(),
    使用镜像: base,
    鉴权原文: usable.msg,
    bark,
    结果: results,
  };
}

// 用「不存在的 cid」做鉴权探针：不产生任何副作用，且能区分
//   未登录 → 「您还没有登录或注册，暂时不能使用此功能」
//   已登录 → 「confirm []是不开放!」之类的任务不存在文案
async function authProbe(base, cookie, ua) {
  const url = `${base}/plugin.php?H_name=tasks&action=ajax&actions=job`
            + `&cid=99999&nowtime=${Date.now()}`;
  const r = await httpGet(url, cookie, ua);
  const msg = stripCdata(r.text);
  return {
    base,
    msg,
    authed: !/您还没有登录|不能使用此功能|未登录/.test(msg),
  };
}

// 推送签到结果到 Bark。BARK 未配置时静默跳过。
async function notifyBark(env, title, body) {
  const base = ((env && env.BARK) || '').trim().replace(/\/+$/, '');
  if (!base) return '未配置 BARK 变量，跳过推送';
  const group = ((env && env.BARK_GROUP) || BARK_GROUP).trim();
  const ttl = Number(((env && env.BARK_TTL) || BARK_TTL) || 0);

  // 优先 POST JSON：正文较长时比把内容塞进 URL 路径可靠
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ title, body, group, ttl }),
    });
    const txt = (await res.text()).slice(0, 120);
    if (res.ok) return `POST ${res.status} ${txt}`;
    console.log('[Bark] POST failed', res.status, txt);
  } catch (e) {
    console.log('[Bark] POST threw', String(e));
  }

  // 兜底 GET：与 curl 示例同形
  try {
    const qs = new URLSearchParams();
    if (group) qs.set('group', group);
    if (ttl) qs.set('ttl', String(ttl));
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${qs}`;
    const res = await fetch(url);
    return `GET ${res.status}`;
  } catch (e) {
    return `推送失败: ${String(e)}`;
  }
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

// ── 共享密钥鉴权 ───────────────────────────────────────────────────────────
// 这个 Worker 挂在公开的 workers.dev 地址上，而仓库本身也是公开的：没有鉴权的话
// 任何人拿到地址就能无限次触发 /sign（刷爆 Cloudflare 额度、耗光 Bark 推送配额，
// 还能从 /probe 读走出口 IP 和页面片段）。
//
// 因此所有 HTTP 路径（含 / 与 /probe）都要求请求头 X-Auth 等于 Worker 变量 SIGN_TOKEN。
// 校验失败一律返回 404，与「未知路径」的响应完全一致，不透露任何路径是否存在。
//
// SIGN_TOKEN 未配置时无人能通过校验 —— 默认拒绝，而不是默认放行。
// 用 `python deploy.py --sign-token <随机串>` 写入，或到
// Settings → Variables and Secrets 手动添加（类型选 Secret）。
//
// 注意：Cron 触发的 scheduled 处理器不经过这里（它只读 env.COOKIE / env.UA），
// 所以启用鉴权不影响定时签到本身。
//
// 比较前先各自 SHA-256，这样比较的是两个等长摘要，避免按字符逐位比较时
// 因提前返回而泄漏前缀信息。
async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function isAuthorized(request, env) {
  const expected = ((env && env.SIGN_TOKEN) || '').trim();
  if (!expected) return false;                       // 未配置密钥 → 全部拒绝
  const provided = (request.headers.get('X-Auth') || '').trim();
  if (!provided) return false;
  return constantTimeEqual(provided, expected);
}

const USAGE = `南+ 签到 Worker

  所有接口都需要请求头 X-Auth（值 = Worker 变量 SIGN_TOKEN），否则返回 404。

  GET /probe                探测四个镜像
  GET /sign                 执行签到
  GET /sign?dry=1           只校验登录态，不提交

  curl -H "X-Auth: $SIGN_TOKEN" https://<名字>.<子域>.workers.dev/sign

传 Cookie：
  · 请求头 X-Cookie: eb9e6_winduser=...
  · 或 Worker 变量 COOKIE（Settings → Variables）

定时：
  Settings → Triggers → Cron Triggers 填  23 1 * * *
`;

export default {
  async fetch(request, env) {
    // 鉴权放在最前面：连 / 和 /probe 也要带密钥。
    // 失败时返回与「未知路径」完全相同的 404，攻击者无法通过状态码或文案区分
    // 「路径不存在」和「密钥不对」。
    if (!(await isAuthorized(request, env))) {
      return new Response('未知路径，试试 / 或 /probe\n', { status: 404 });
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const cookie = cookieOf(env, request);
    const ua = (request.headers.get('X-UA') || (env && env.UA) || '').trim();

    if (path === '/') {
      return new Response(USAGE, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (path === '/probe') return json(await doProbe(cookie, ua));
    if (path === '/ajax') {
      const q = new URL(request.url).searchParams;
      const action = (q.get('actions') || 'job').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
      const cid = (q.get('cid') || '99999').replace(/[^0-9]/g, '').slice(0, 6) || '99999';
      return json(await doAjax(cookie, action, cid, Number(q.get('mirror') || 0), ua));
    }
    if (path === '/sign') {
      const dry = new URL(request.url).searchParams.get('dry') === '1';
      return json(await doSign(env, cookie, dry, ua));
    }
    return new Response('未知路径，试试 / 或 /probe\n', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // 定时任务没有请求对象，Cookie 和 UA 都从 Worker 变量取（都要设！只设 Cookie 会因 UA 不符而失败）
    ctx.waitUntil(doSign(env, cookieOf(env, null), false, (env && env.UA) || ''));
  },
};
