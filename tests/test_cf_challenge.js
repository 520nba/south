// 验证：CF 挑战页不再被当成「已登录 + 签到成功」。
//
// 复现的真实故障（2026-09-30 Bark 推送）：
//   标题：南+ 签到（本次无变化）
//   正文：· 日常任务：Just a moment...*{box-sizing:border-box;margin:0;padding:0}html{...}
//
// 根因：authProbe 只判断「有没有未登录字样」，而 CF 挑战页两者都没有 →
// authed: true → 后续请求全拿挑战页 → 结果不以 success 开头 →
// 推送「本次无变化」，把「被 CF 挡住」伪装成「签到过了但没变化」。
//
// 运行：node tests/test_cf_challenge.js
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${extra}`); }
}

// 最小 Request 替身：worker 只用 url 和 headers.get
class FakeRequest {
  constructor(url, init) {
    this.url = url;
    const h = (init && init.headers) || {};
    this.headers = { get: (k) => h[k] ?? null };
  }
}
class FakeResponse {
  constructor(body, init) { this.body = body; this.init = init || {}; }
}

// ── 真实形态的 fixture ────────────────────────────────────────────────
// 与用户收到的那条推送正文完全同形（含 <style> 内容）
const CF_PAGE = '<!DOCTYPE html><html><head><title>Just a moment...</title>'
  + '<style>*{box-sizing:border-box;margin:0;padding:0}html{line-height:1.15;'
  + '-webkit-text-size-adjust:100%;color:#313131}</style></head>'
  + '<body><div id="cf-challenge-running"></div>'
  + '<script>window._cf_chl_opt={cvId:"3"}</script></body></html>';

// CF 标记被推到很后面（验证 looksCF 扫全文而不是只扫前 4000 字符）
const CF_PAGE_LATE = '<html><head><title>north plus</title></head><body>'
  + 'x'.repeat(6000) + '<div>Just a moment...</div></body></html>';

const AJAX_SUCCESS = '<![CDATA[success\t已领取奖励 3 金币]]>';
const AJAX_NOT_OPEN = '<![CDATA[confirm []是不开放!]]>';
const AJAX_NOT_LOGGED_IN = '<![CDATA[您还没有登录或注册，暂时不能使用此功能]]>';

// ── 把 worker 载进沙箱，注入可编程的 fetch ────────────────────────────
function loadWorker(responses) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'cloudflare-worker', 'sign-worker.js'), 'utf8');
  const calls = [];
  let idx = 0;
  const fakeFetch = async (url) => {
    calls.push(url);
    const r = responses[idx++] ?? responses[responses.length - 1];
    const text = typeof r === 'function' ? r(url) : r.text;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      headers: { get: () => null },
      text: async () => text,
    };
  };
  const sandbox = {
    fetch: fakeFetch,
    console: { log: () => {}, error: () => {} },
    URL, URLSearchParams, Date, JSON, Math, String, Number, RegExp, Promise,
    setTimeout, TextEncoder, Response: FakeResponse,
    // constantTimeEqual 用 crypto.subtle.digest 做定长比较，沙箱里必须提供
    crypto: webcrypto,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // worker 用 ESM 的 export default，去掉 export 关键字后按脚本执行
  vm.runInContext(src.replace('export default {', 'globalThis.__w = {'), sandbox);
  return { worker: sandbox.__w, calls };
}

// notifyBark 会真的发 HTTP；不配置 BARK 时它会直接跳过
const NO_BARK = {};

async function runSign(responses) {
  const { worker, calls } = loadWorker(responses);
  const req = new FakeRequest('https://w.dev/sign',
    { headers: { 'X-Auth': 'tok' } });
  const env = { SIGN_TOKEN: 'tok', COOKIE: 'eb9e6_winduser=abc; foo=1', UA: 'UA/1', ...NO_BARK };
  const res = await worker.fetch(req, env);
  const body = JSON.parse(res.body);
  return { result: body, calls, status: res.init && res.init.status };
}

(async () => {
  console.log('='.repeat(72));
  console.log('A) 纯函数：CF 判定 / 样式剥离');
  console.log('='.repeat(72));
  // 直接测函数：把 worker 源码里的函数抽出来单测不方便，改用行为测试。
  // 这里先跑一遍「全 CF 响应」的整体行为，断言不出现误导性成功。

  console.log();
  console.log('='.repeat(72));
  console.log('B) 复现原故障：所有请求都返回 CF 挑战页');
  console.log('='.repeat(72));
  // 4 个镜像 × 1 次探针 = 前 4 次 → 全 CF；之后（若有）也是 CF
  const allCF = Array.from({ length: 12 }, () => ({ status: 403, text: CF_PAGE }));
  const r1 = await runSign(allCF);
  const res1 = r1.result;

  check('ok 为 false（不再谎报成功）', res1.ok === false, `ok=${res1.ok}`);
  check('没有 auth_ok:true 的误导', res1.auth_ok === undefined, `auth_ok=${res1.auth_ok}`);
  check('类型是 CF 拦截失败', /CF|Cloudflare/.test(String(res1.reason)), String(res1.reason).slice(0, 80));
  check('reason 明确说是 CF 拦截，而非「未登录」',
    /拦截/.test(String(res1.reason)) && !/^所有镜像都判为未登录/.test(String(res1.reason)),
    String(res1.reason).slice(0, 80));
  check('reason 点明「不代表 Cookie 失效」',
    /不代表 Cookie 失效/.test(String(res1.reason)), String(res1.reason).slice(0, 120));
  check('未进入签到流程（只做了探针，没有 job2 请求）',
    r1.calls.every((u) => !u.includes('actions=job2')), `calls=${r1.calls.length}`);
  check('鉴权探针带 cf 标记', Array.isArray(res1.鉴权探针)
    && res1.鉴权探针.every((p) => p.cf === true), JSON.stringify(res1.鉴权探针 || []).slice(0, 120));
  check('鉴权探针没有 authed:true', res1.鉴权探针.every((p) => p.authed === false),
    JSON.stringify((res1.鉴权探针 || []).map((p) => p.authed)));
  check('推送文案不含 CSS 样式表垃圾',
    !/\*\{box-sizing/.test(JSON.stringify(res1)), '正文里混进了 CSS');
  check('推送文案不含 "本次无变化"',
    !/本次无变化/.test(JSON.stringify(res1)), '仍推送了误导性标题');

  // 旧实现的行为对照：把 authed 判定还原成「只看未登录字样」应当误判
  const naiveAuthed = !/您还没有登录|不能使用此功能|未登录/.test(
    CF_PAGE.replace(/<[^>]+>/g, '').trim());
  check('（对照）旧判据在 CF 页上确实会误判为已登录', naiveAuthed === true,
    '若此处为 false，说明 fixture 不再能代表当初的故障');

  console.log();
  console.log('='.repeat(72));
  console.log('C) CF 标记被推到大页面后段也要能识别');
  console.log('='.repeat(72));
  const lateCF = Array.from({ length: 12 }, () => ({ status: 200, text: CF_PAGE_LATE }));
  const r2 = await runSign(lateCF);
  check('扫全文：后段的 CF 标记也能识别', r2.result.ok === false, `ok=${r2.result.ok}`);
  check('后段标记同样判为 CF', /拦截/.test(String(r2.result.reason)),
    String(r2.result.reason).slice(0, 80));

  console.log();
  console.log('='.repeat(72));
  console.log('D) 正常签到：成功 / 冷却期无变化');
  console.log('='.repeat(72));
  // 探针（4 镜像）：第 1 个已登录、其余未登录；然后 2 个任务各 2 次请求
  const okFlow = [
    { status: 200, text: AJAX_NOT_OPEN },        // 镜像1 探针 → 已登录
    { status: 200, text: AJAX_NOT_LOGGED_IN },
    { status: 200, text: AJAX_NOT_LOGGED_IN },
    { status: 200, text: AJAX_NOT_LOGGED_IN },
    { status: 200, text: AJAX_SUCCESS },          // 日常 job
    { status: 200, text: AJAX_SUCCESS },          // 日常 job2
    { status: 200, text: AJAX_SUCCESS },          // 周常 job
    { status: 200, text: AJAX_SUCCESS },          // 周常 job2
  ];
  const r3 = await runSign(okFlow);
  check('签到成功时 ok=true', r3.result.ok === true, `ok=${r3.result.ok}`);
  check('auth_ok=true', r3.result.auth_ok === true, `auth_ok=${r3.result.auth_ok}`);
  check('CF拦截=0', r3.result.CF拦截 === 0, `CF拦截=${r3.result.CF拦截}`);
  check('执行了 2 个任务的 4 次请求',
    r3.calls.filter((u) => u.includes('action=ajax')).length === 8,
    `实际 ${r3.calls.filter((u) => u.includes('action=ajax')).length} 次`);

  console.log();
  console.log('='.repeat(72));
  console.log('E) 未登录（非 CF）：要如实说是未登录');
  console.log('='.repeat(72));
  const notLogged = Array.from({ length: 8 }, () => ({ status: 200, text: AJAX_NOT_LOGGED_IN }));
  const r4 = await runSign(notLogged);
  check('ok=false', r4.result.ok === false, `ok=${r4.result.ok}`);
  check('判为未登录而非 CF', /未登录/.test(String(r4.result.reason))
    && !/拦截/.test(String(r4.result.reason)), String(r4.result.reason).slice(0, 80));
  check('未进入签到流程', r4.calls.every((u) => !u.includes('actions=job2')));

  console.log();
  console.log('='.repeat(72));
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log('='.repeat(72));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
