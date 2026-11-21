#!/usr/bin/env node
'use strict';

/**
 * 发布脚本：构建 → 校验 → 提交 → 推送
 *
 *   node publish.js                    自动生成提交信息并推送
 *   node publish.js -m "fix: xxx"      指定提交信息
 *   node publish.js --dry-run          只构建+校验+展示将要提交的内容，不提交不推送
 *   node publish.js --no-push          只提交到本地，不推送
 *
 * 设计原则：
 * 1. 任一环节失败就停下，绝不推半成品。构建或校验不过时不会产生提交。
 * 2. 没有实际变更时不产生空提交。
 * 3. 推送前先 pull --rebase，避免远端有新提交时变成 non-fast-forward。
 * 4. 全程非交互：凭据由系统凭据管理器提供（已验证可用）。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_PUSH = args.includes('--no-push');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const bold = c('1'), green = c('32'), red = c('31'), yellow = c('33'), dim = c('2');

function die(msg) {
  console.error(`\n${red('发布中止：')} ${msg}\n`);
  process.exit(1);
}

/** 跑外部命令；失败时把 stderr 带出来，而不是吞掉。 */
function run(cmd, argv, { allowFail = false } = {}) {
  try {
    const out = execFileSync(cmd, argv, {
      cwd: HERE,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',   // 绝不弹窗要密码
        GCM_INTERACTIVE: 'never',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: (out || '').trim() };
  } catch (err) {
    const out = String(err.stdout || '') + String(err.stderr || '');
    if (allowFail) return { ok: false, out: out.trim() };
    die(`${cmd} ${argv.join(' ')} 失败：\n${out.trim()}`);
  }
}

/* ------------------------------------------------------------ 解析提交信息 */

function commitMessage() {
  const i = args.indexOf('-m');
  if (i >= 0 && args[i + 1]) return args[i + 1];

  // 未指定时按变更范围自动生成
  const st = run('git', ['status', '--porcelain']).out;
  const lines = st.split('\n').filter(Boolean);
  const files = lines.map((l) => l.slice(3).trim());

  const touched = new Set();
  if (files.some((f) => f === 'plugin.js' || f === 'plugin.json')) touched.add('插件源码');
  if (files.some((f) => f.startsWith('dist/'))) touched.add('构建产物');
  if (files.some((f) => f === 'build.js' || f === 'verify.js' || f === 'smoke.js')) touched.add('开发脚本');
  if (files.some((f) => f === 'README.md')) touched.add('文档');

  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(HERE, 'plugin.json'), 'utf8')).Version || '';
  } catch { /* 读不到就不写版本 */ }

  const scope = [...touched].join('、') || '未分类';
  const head = version ? `chore: 更新 ${scope}（v${version}）` : `chore: 更新 ${scope}`;
  return `${head}\n\n变更文件：\n${files.map((f) => `- ${f}`).join('\n')}`;
}

/* ---------------------------------------------------------------- 主流程 */

function main() {
  console.log(`\n${bold('发布 xmding')}`);
  if (DRY) console.log(yellow('  (dry-run：不提交、不推送)'));
  console.log('');

  /* 1. 确认在 git 仓库里 */
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  if (!inside.ok || inside.out !== 'true') die('当前目录不是 git 仓库');

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (branch !== 'main') {
    console.log(yellow(`  ! 当前在 ${branch} 分支，不是 main`));
  }

  /* 2. 构建 */
  console.log(`${dim('›')} 构建安装包`);
  const build = run('node', [path.join(HERE, 'build.js')]);
  const shaLine = build.out.split('\n').find((l) => l.includes('SHA-256')) || '';
  console.log(`  ${green('✓')} ${shaLine.trim().replace(/^.*SHA-256\s*/, 'SHA-256 ')}`);

  /* 3. 校验 —— 不过就不提交 */
  console.log(`${dim('›')} 校验安装包`);
  const verify = run('node', [path.join(HERE, 'verify.js')], { allowFail: true });
  if (!verify.ok) die(`包校验未通过，已停止（不会推送）：\n${verify.out}`);
  console.log(`  ${green('✓')} 校验通过`);

  /* 4. 看有没有变更 */
  const status = run('git', ['status', '--porcelain']).out;
  if (!status) {
    console.log(`\n${green('没有变更，无需发布。')}\n`);
    return;
  }

  const changed = status.split('\n').filter(Boolean);
  console.log(`\n${dim('›')} 待提交 ${changed.length} 个文件`);
  for (const line of changed) console.log(`    ${line}`);

  /* 5. 敏感信息检查 —— 防止 token 之类被推上去 */
  console.log(`\n${dim('›')} 检查敏感信息`);
  const risky = [];
  const SECRETS = [
    { name: 'sk_xmm token', re: /sk_xmm_[A-Za-z0-9]{10,}/ },
    { name: 'API Key 形态', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
    { name: '内网地址', re: /\b10\.0\.1\.\d{1,3}\b/ },
  ];
  for (const line of changed) {
    const f = line.slice(3).trim();
    if (f.endsWith('.zip')) continue;         // 二进制跳过
    let text;
    try { text = fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { continue; }
    for (const s of SECRETS) {
      if (s.re.test(text)) risky.push(`${f}: 疑似 ${s.name}`);
    }
  }
  if (risky.length) {
    console.error(`\n${red('发现疑似敏感信息，已停止：')}`);
    for (const r of risky) console.error(`    ✗ ${r}`);
    die('请先清理这些内容再发布');
  }
  console.log(`  ${green('✓')} 未发现敏感信息`);

  if (DRY) {
    console.log(`\n${yellow('dry-run 结束。')} 以上内容本可提交并推送。\n`);
    return;
  }

  /* 6. 提交 */
  const msg = commitMessage();
  console.log(`\n${dim('›')} 提交`);
  run('git', ['add', '-A']);
  run('git', ['commit', '-m', msg]);
  const head = run('git', ['log', '--oneline', '-1']).out;
  console.log(`  ${green('✓')} ${head}`);

  if (NO_PUSH) {
    console.log(`\n${green('已提交到本地。')} 未推送（--no-push）。\n`);
    return;
  }

  /* 7. 推送前同步远端，避免 non-fast-forward */
  console.log(`\n${dim('›')} 同步远端`);
  const fetch = run('git', ['fetch', 'origin'], { allowFail: true });
  if (!fetch.ok) {
    console.error(`  ${yellow('!')} fetch 失败，仍尝试直接推送`);
  }
  const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main'], { allowFail: true });
  if (behind.ok && Number(behind.out) > 0) {
    console.log(`  远端领先 ${behind.out} 个提交，先 rebase`);
    const rb = run('git', ['rebase', 'origin/main'], { allowFail: true });
    if (!rb.ok) {
      run('git', ['rebase', '--abort'], { allowFail: true });
      die('rebase 失败（可能有冲突）。已回滚 rebase，请手动处理后重试。');
    }
    console.log(`  ${green('✓')} rebase 完成`);
  } else {
    console.log(`  ${green('✓')} 无需 rebase`);
  }

  /* 8. 推送 */
  console.log(`\n${dim('›')} 推送到 origin`);
  const push = run('git', ['push', 'origin', 'HEAD:main'], { allowFail: true });
  if (!push.ok) die(`推送失败：\n${push.out}`);
  console.log(`  ${green('✓')} 已推送`);

  const remote = run('git', ['log', '--oneline', '-1', 'origin/main'], { allowFail: true });
  if (remote.ok) console.log(`  ${dim('远端最新：' + remote.out)}`);

  console.log(`\n${green(bold('发布完成。'))}\n`);
}

main();
