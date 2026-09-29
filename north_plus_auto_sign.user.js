// ==UserScript==
// @name         n+ / 南+ 社区任务自动签到
// @namespace    local.north_plus_sign
// @version      1.0.0
// @description  打开论坛页面即自动申请并完成「日常」「周常」任务，本地冷却记录避免重复请求
// @author       local
// @match        https://*.north-plus.net/*
// @match        https://*.south-plus.net/*
// @match        https://*.summer-plus.net/*
// @match        https://*.level-plus.net/*
// @match        https://*.white-plus.net/*
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

/*
 * 与 sign_north.py 的区别：
 *   - 这个脚本在浏览器里跑，直接借用当前登录态，不用抓 Cookie，也不怕 Cookie 过期；
 *     代价是必须打开一次论坛页面才会触发。
 *   - 想要「不开浏览器也自动签到」，用同目录的 sign_north.py + Windows 计划任务。
 *
 * 冷却时间按任务的真实周期留了点余量：日常 20h（任务周期 24h），周常 150h（周期 168h）。
 * 目的是避免每翻一页都打一次接口，不是卡点抢时间。
 */

(function () {
  'use strict';

  const TASKS = [
    { cid: 15, name: '日常任务', cooldownH: 20 },
    { cid: 14, name: '周常任务', cooldownH: 150 },
  ];
  const GAP_MS = 1600;          // 申请 → 领奖之间的等待
  const KEY_PREFIX = 'nps_last_';

  // 未登录就安静退出
  if (document.querySelector('input[name="pwuser"]') || document.body.innerText.includes('您没有登录')) {
    return;
  }

  function toast(text, bad) {
    let box = document.getElementById('nps-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nps-toast';
      box.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:99999',
        'max-width:320px', 'padding:10px 14px', 'border-radius:8px',
        'font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif',
        'background:#2b2b2b', 'color:#fff', 'box-shadow:0 6px 20px rgba(0,0,0,.28)',
        'white-space:pre-line', 'opacity:.96',
      ].join(';');
      document.body.appendChild(box);
    }
    box.style.background = bad ? '#a4322c' : '#2b6b3f';
    box.textContent = text;
    clearTimeout(box._t);
    box._t = setTimeout(() => box.remove(), 6000);
  }

  // 接口返回 <?xml ...?><ajax><![CDATA[...]]></ajax>
  function cdata(t) {
    const m = t.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return (m ? m[1] : t).trim();
  }

  async function ajax(action, cid) {
    const url = `/plugin.php?H_name=tasks&action=ajax&actions=${action}&cid=${cid}&nowtime=${Date.now()}`;
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return cdata(await res.text());
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runTask(task) {
    const last = Number(localStorage.getItem(KEY_PREFIX + task.cid) || 0);
    if (Date.now() - last < task.cooldownH * 3600 * 1000) {
      console.log(`[n+签到] ${task.name} 冷却中，跳过（距上次 ${((Date.now() - last) / 3600000).toFixed(1)}h）`);
      return null;
    }

    let jobMsg = '', rewardMsg = '';
    try {
      jobMsg = await ajax('job', task.cid);
      await sleep(GAP_MS);
      rewardMsg = await ajax('job2', task.cid);
    } catch (e) {
      return { name: task.name, ok: false, msg: '请求异常：' + e.message };
    }

    // 无论成败都记时间：失败多半是「已领取/冷却中」，重复打接口没意义
    localStorage.setItem(KEY_PREFIX + task.cid, String(Date.now()));

    const ok = /成功|success/i.test(rewardMsg) || /已领取|已经领取|已完成|已经完成/.test(rewardMsg);
    return { name: task.name, ok, msg: `${jobMsg} → ${rewardMsg}` };
  }

  (async () => {
    const results = [];
    for (const task of TASKS) {
      const r = await runTask(task);
      if (r) results.push(r);
      await sleep(600);
    }
    if (!results.length) return;

    const lines = results.map((r) => `${r.ok ? '✓' : '×'} ${r.name}：${r.msg}`).join('\n');
    console.log('[n+签到]\n' + lines);
    toast(lines, results.some((r) => !r.ok));
  })();
})();
