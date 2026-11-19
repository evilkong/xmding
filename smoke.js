'use strict';
/**
 * xmding 功能回归测试（对已部署的本机内核发真实请求）
 *   node smoke.js
 * 只调用只读/预检接口，不会真的往微信发消息。
 */
const http = require('node:http');

const TOKEN = 'REDACTED_XMDING_TOKEN';
const HOST = '127.0.0.1';
const PORT = 8787;

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ id: 'xmding', input: payload }), 'utf8');
    const req = http.request({
      host: HOST, port: PORT, path: '/api/plugins/run', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'x-bot-token': TOKEN,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text).result); }
        catch { reject(new Error('bad json: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
}

(async () => {
  console.log('\nxmding 功能回归\n');

  // 1. ping
  const ping = await post({ action: 'ping' });
  check('ping 返回 ok', ping.ok === true, JSON.stringify(ping));
  check('ping 报告 api=4', ping.api === 4);
  check('ping 带版本号', typeof ping.version === 'string' && ping.version.length > 0, ping.version);

  // 2. list
  const list = await post({ action: 'list', q: '研发', chatType: 'group' });
  check('list 返回 ok', list.ok === true, JSON.stringify(list).slice(0, 160));
  check('list 返回数组', Array.isArray(list.items));
  check('list 命中预期群', (list.items || []).some((x) => x.label === '久客研发中心'),
    JSON.stringify((list.items || []).map((x) => x.label)));

  // 3. dryRun 按名称
  const dry = await post({ to: '久客研发中心', text: 'x', dryRun: true });
  check('dryRun 成功', dry.ok === true, JSON.stringify(dry).slice(0, 200));
  check('dryRun 标记 dryRun', dry.dryRun === true);
  check('dryRun 未入队', dry.queued === false);
  check('按名称解析', dry.matchedBy === 'name', dry.matchedBy);
  check('解析出 chatroom ID', /@chatroom$/.test(dry.chatId || ''), dry.chatId);
  check('chatType=group', dry.chatType === 'group');

  // 4. dryRun 按 ID
  const byId = await post({ chatId: '23632011396@chatroom', text: 'x', dryRun: true });
  check('按 chatId 解析', byId.ok === true && byId.matchedBy === 'id', JSON.stringify(byId).slice(0, 160));

  // 5. 歧义拒发
  const amb = await post({ to: '研发中心', text: 'x', dryRun: true });
  check('歧义被拒', amb.ok === false && amb.code === 'ambiguous_target', JSON.stringify(amb).slice(0, 160));
  check('歧义给出候选', Array.isArray(amb.candidates) && amb.candidates.length >= 2,
    JSON.stringify(amb.candidates || []).slice(0, 160));

  // 6. 找不到
  const nf = await post({ to: '绝对不存在的群zzz999', text: 'x' });
  check('不存在被拒', nf.ok === false && nf.code === 'target_not_found', JSON.stringify(nf).slice(0, 160));

  // 7. 缺目标
  const mt = await post({ text: 'x' });
  check('缺目标被拒', mt.ok === false && mt.code === 'missing_target');

  // 8. 空正文
  const et = await post({ to: '久客研发中心' });
  check('空正文被拒', et.ok === false && et.code === 'empty_text');

  // 9. 超长正文
  const long = await post({ to: '久客研发中心', text: 'a'.repeat(4001) });
  check('超长正文被拒', long.ok === false && long.code === 'text_too_long', long.code);

  // 10. 非法 delivery
  const badD = await post({ to: '久客研发中心', text: 'x', delivery: 'video' });
  check('非法 delivery 被拒', badD.ok === false && badD.code === 'invalid_delivery', badD.code);

  // 11. 非法 action
  const badA = await post({ action: 'drop' });
  check('非法 action 被拒', badA.ok === false && badA.code === 'invalid_action');

  // 12. status 缺 id
  const noId = await post({ action: 'status' });
  check('status 缺 id 被拒', noId.ok === false && noId.code === 'missing_id');

  // 13. status 未知 id
  const unk = await post({ action: 'status', id: '00000000-0000-0000-0000-000000000000' });
  check('未知 id 返回非 ok', unk.ok === false, JSON.stringify(unk).slice(0, 160));

  // 14. 群成员名含特殊字符的目标
  const weird = await post({ to: '一⃔窝⃔子⃔ネф̶ イω', text: 'x', dryRun: true });
  check('特殊字符群名可解析', weird.ok === true && weird.dryRun === true,
    JSON.stringify(weird).slice(0, 200));

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
