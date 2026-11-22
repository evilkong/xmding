#!/usr/bin/env node
'use strict';

/**
 * WhaleGirl 远程插件接口补丁
 *
 * 背景：src/http/routes/plugins.js 有一道比全局安全闸更严的「只许环回」硬闸，
 * 导致远程（局域网）调用 /api/plugins/* 一律 403「插件控制仅允许本机访问」，
 * 即使 config.json 已设 allowRemote=true 且 x-bot-token 正确也没用。
 *
 * 本补丁把它改成与 security.js 一致的语义：
 *   本机放行；远程必须 allowRemote=true 且 x-bot-token 正确。
 *
 * 重要：WhaleGirl 升级会整体覆盖 src/ 目录，补丁会被冲掉。
 *       升级后重新跑一次本脚本即可恢复。
 *
 *   node patch-remote.js            检查并打补丁
 *   node patch-remote.js --check    只检查当前状态
 *   node patch-remote.js --revert   还原为官方原版
 *   node patch-remote.js --root <WhaleGirl 根目录>
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const bold = c('1'), green = c('32'), red = c('31'), yellow = c('33'), dim = c('2');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const REVERT = args.includes('--revert');

/* ------------------------------------------------------------ 定位根目录 */

function looksLikeRoot(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(path.join(dir, 'server.js')).isFile()
      && fs.statSync(path.join(dir, 'src', 'http', 'routes', 'plugins.js')).isFile();
  } catch { return false; }
}

function findRoot() {
  const i = args.indexOf('--root');
  const explicit = i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : '';
  const candidates = [
    explicit,
    process.env.WHALE_ROOT,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WhaleGirl'),
    'C:\\Program Files\\WhaleGirl',
    'D:\\WhaleGirl',
  ].filter(Boolean);

  for (const dir of candidates) if (looksLikeRoot(dir)) return dir;

  console.error(`\n${red('找不到 WhaleGirl 根目录')}（需要含 server.js 与 src/http/routes/plugins.js）`);
  console.error('  请用 --root 指定，例如：');
  console.error('    node patch-remote.js --root "C:\\\\...\\\\WhaleGirl"\n');
  process.exit(1);
}

const ROOT = findRoot();
const TARGET = path.join(ROOT, 'src', 'http', 'routes', 'plugins.js');
const BACKUP = TARGET + '.orig';

/* ------------------------------------------------------------- 补丁内容 */

/** 原版那一行（官方 4.1.8 的写法） */
const OFFICIAL_GATE =
  "    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '插件控制仅允许本机访问' });";

/** 补丁后的写法 */
const PATCHED_GATE = `    // 本机放行；远程必须同时满足 server.allowRemote=true 且 x-bot-token 正确
    // （与 security.js 里 /api/* 的远程闸同一口径，不再是一刀切的「只许环回」）。
    // 插件拥有 system.full 权限，所以绝不因为「开了 allowRemote」就免鉴权。
    if (!isLoopbackRequest(req) && !remoteAuthorized(req, runtime)) {
      return json(res, 403, { ok: false, error: '远程调用插件需要 server.allowRemote=true 且 x-bot-token 正确' });
    }`;

const OFFICIAL_IMPORT = "const { isLoopbackRequest } = require('../security');";
const PATCHED_IMPORT = "const { isLoopbackRequest, remoteAuthorized } = require('../security');";

/* ---------------------------------------------------------------- 工具 */

function status(text) {
  if (text.includes(PATCHED_GATE) || (text.includes('remoteAuthorized') && text.includes('!isLoopbackRequest(req) && !remoteAuthorized'))) {
    return 'patched';
  }
  if (text.includes(OFFICIAL_GATE)) return 'official';
  return 'unknown';
}

function writeAtomic(file, content) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, content, { encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- 主流程 */

function main() {
  console.log(`\n${bold('WhaleGirl 远程插件接口补丁')}\n`);
  console.log(`  ${dim('目标文件')} ${TARGET}`);

  if (!fs.existsSync(TARGET)) {
    console.error(`\n${red('文件不存在')}：${TARGET}\n`);
    process.exit(1);
  }

  const original = fs.readFileSync(TARGET, 'utf8');
  const state = status(original);

  const label = { patched: '已打补丁', official: '官方原版', unknown: '未知（可能被其他改动过）' }[state];
  console.log(`  ${dim('当前状态')} ${state === 'patched' ? green(label) : yellow(label)}`);

  /* ---- 只检查 ---- */
  if (CHECK_ONLY) {
    console.log('');
    if (state === 'patched') {
      console.log(`  ${green('✓')} 远程调用已放开（allowRemote + token）`);
    } else if (state === 'official') {
      console.log(`  ${yellow('!')} 仍未打补丁，远程调用会 403`);
      console.log(`    ${dim('修复：node patch-remote.js')}`);
    }
    console.log('');
    process.exit(state === 'patched' ? 0 : 1);
  }

  /* ---- 还原 ---- */
  if (REVERT) {
    if (!fs.existsSync(BACKUP)) {
      console.error(`\n${red('没有备份文件，无法还原')}：${BACKUP}`);
      console.error(`  ${dim('备份只在首次打补丁时创建。')}\n`);
      process.exit(1);
    }
    fs.copyFileSync(BACKUP, TARGET);
    console.log(`\n  ${green('✓')} 已还原为备份版本`);
    console.log(`  ${dim('来源')} ${BACKUP}\n`);
    console.log(`  ${yellow('需要重启内核才生效。')}\n`);
    process.exit(0);
  }

  /* ---- 打补丁 ---- */
  if (state === 'patched') {
    console.log(`\n  ${green('✓')} 已经是补丁状态，无需重复操作。\n`);
    console.log(`  ${yellow('若改了 config.json 的 allowRemote/token，需重启内核生效。')}\n`);
    process.exit(0);
  }

  if (state === 'unknown') {
    console.error(`\n${red('无法识别当前文件结构，已停止。')}`);
    console.error('  可能是 WhaleGirl 版本变化导致代码不同，请人工确认后再改。');
    console.error(`  ${dim(TARGET)}\n`);
    process.exit(1);
  }

  // 首次打补丁：留一份原版备份
  if (!fs.existsSync(BACKUP)) {
    fs.copyFileSync(TARGET, BACKUP);
    console.log(`  ${green('✓')} 已备份原版到 ${path.basename(BACKUP)}`);
  } else {
    console.log(`  ${dim('备份已存在，保留不覆盖')} ${path.basename(BACKUP)}`);
  }

  // 应用替换：import 行 + 闸门
  let patched = original;
  if (!patched.includes(OFFICIAL_IMPORT)) {
    console.error(`\n${red('未找到预期的 import 行，已停止。')}\n`);
    process.exit(1);
  }
  patched = patched.replace(OFFICIAL_IMPORT, PATCHED_IMPORT);
  patched = patched.replace(OFFICIAL_GATE, PATCHED_GATE);

  if (status(patched) !== 'patched') {
    console.error(`\n${red('替换后校验失败，未写入。')}\n`);
    process.exit(1);
  }

  writeAtomic(TARGET, patched);

  // 写入后语法校验，失败自动回滚
  if (!syntaxOk(TARGET)) {
    fs.copyFileSync(BACKUP, TARGET);
    console.error(`\n${red('补丁后语法检查失败，已自动回滚。')}\n`);
    process.exit(1);
  }

  console.log(`  ${green('✓')} 已写入补丁（语法检查通过）`);
  console.log('');
  console.log(`  ${yellow('需要重启内核才生效：')}启动器里点「重启」。`);
  console.log(`  ${dim('验证方式：向 http://<局域网IP>:8787/api/plugins/run 发 POST，带 x-bot-token 与 Content-Type: application/json')}`);
  console.log('');
}

main();
