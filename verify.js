#!/usr/bin/env node
'use strict';

/**
 * xmding 包校验器 —— 独立于 build.js 的 ZIP 解读实现。
 *
 *   node verify.js                     校验 dist/ 里最新的包
 *   node verify.js <zip路径>           校验指定包
 *
 * 目的：build.js 生成、verify.js 复核。两者不共享 ZIP 解析代码，
 * 避免「自己写错、自己验过」。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const DIST = path.join(__dirname, 'dist');
const LIMITS = { zip: 16 * 1024 * 1024, code: 8 * 1024 * 1024 };

let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails++; console.log(`  ✗ ${m}`); };
const warn = (m) => { warns++; console.log(`  ! ${m}`); };

/* ------------------------------------------------ 独立 ZIP 解析（读中央目录） */

function readZip(buf) {
  // 从尾部找 EOCD（签名 0x06054b50），最多回退 65557 字节（含注释上限）
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 结束记录（不是合法 ZIP）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (cdOffset + cdSize > buf.length) throw new Error('中央目录越界');

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`第 ${n + 1} 项中央目录签名错误`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // 定位本地头以拿到数据起点
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name}: 本地头签名错误`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${name}: 不支持的压缩方式 ${method}`);

    // 校验 CRC 与大小
    if (data.length !== usize) throw new Error(`${name}: 解压后大小不符`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC 校验失败`);

    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function crc32(buf) {
  const table = crc32.t || (crc32.t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/* ------------------------------------------------------------------ 主流程 */

function pickZip() {
  const arg = process.argv[2];
  if (arg) {
    if (!fs.existsSync(arg)) { console.error(`找不到文件：${arg}`); process.exit(1); }
    return path.resolve(arg);
  }
  if (!fs.existsSync(DIST)) { console.error('dist/ 不存在，请先执行 node build.js'); process.exit(1); }
  const zips = fs.readdirSync(DIST).filter((n) => n.endsWith('.zip'));
  if (!zips.length) { console.error('dist/ 里没有 zip，请先执行 node build.js'); process.exit(1); }
  return path.join(DIST, zips.sort().pop());
}

function main() {
  const zipPath = pickZip();
  const buf = fs.readFileSync(zipPath);

  console.log(`\n校验 ${path.basename(zipPath)}\n`);

  /* 1. 体积与摘要 */
  console.log('包体积与摘要');
  if (buf.length <= LIMITS.zip) ok(`${buf.length} 字节，在上限 16 MiB 内`);
  else bad(`${buf.length} 字节，超过 16 MiB`);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  ok(`SHA-256 ${sha}`);

  // 与 .json 校验信息比对
  const metaFile = zipPath.replace(/\.zip$/, '.json');
  if (fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta.sha256 === sha) ok('与 build.js 记录的 SHA-256 一致');
      else bad(`SHA-256 不一致：记录 ${meta.sha256}`);
    } catch (e) { warn(`校验信息无法解析：${e.message}`); }
  } else {
    warn('没有同名 .json 校验信息，跳过一致性比对');
  }

  /* 2. 结构 */
  console.log('\n包结构');
  let entries;
  try {
    entries = readZip(buf);
  } catch (err) {
    bad(`ZIP 解析失败：${err.message}`);
    return done();
  }

  const names = entries.map((e) => e.name);
  ok(`共 ${entries.length} 个文件：${names.join(', ')}`);

  // 规范：根目录仅 plugin.json 和 plugin.js
  const extra = names.filter((n) => n !== 'plugin.json' && n !== 'plugin.js');
  if (extra.length) bad(`根目录有多余文件（规范只允许 plugin.json + plugin.js）：${extra.join(', ')}`);
  else ok('根目录只有 plugin.json 和 plugin.js');

  const nested = names.filter((n) => n.includes('/'));
  if (nested.length) bad(`存在子目录（不符规范）：${nested.join(', ')}`);
  else ok('没有子目录');

  for (const need of ['plugin.json', 'plugin.js']) {
    if (!names.includes(need)) bad(`缺少 ${need}`);
  }
  if (fails) return done();

  /* 3. 清单 */
  console.log('\n清单 plugin.json');
  const manifestEntry = entries.find((e) => e.name === 'plugin.json');
  // BOM 检查
  const raw = manifestEntry.data;
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) bad('plugin.json 带 UTF-8 BOM');
  else ok('plugin.json 无 BOM');

  let m;
  try { m = JSON.parse(raw.toString('utf8')); }
  catch (e) { bad(`plugin.json 不是合法 JSON：${e.message}`); return done(); }

  for (const k of ['Id', 'Name', 'Author', 'Version', 'MinAppVersion', 'Description', 'ResultLabel', 'Api', 'Kind']) {
    if (m[k] === undefined || m[k] === '') bad(`缺少必填字段 ${k}`);
  }
  if (/^[a-z][a-z0-9-]*$/.test(m.Id || '')) ok(`Id = ${m.Id}（格式合法）`);
  else bad(`Id 格式非法：${m.Id}`);

  if (m.Api === 4) ok('Api = 4');
  else bad(`Api 应为 4，实际 ${m.Api}`);
  if (['tool', 'message'].includes(m.Kind)) ok(`Kind = ${m.Kind}`);
  else bad(`Kind 非法：${m.Kind}`);
  if (JSON.stringify(m.Permissions) === JSON.stringify(['system.full'])) ok('Permissions = ["system.full"]');
  else bad(`Permissions 应为 ["system.full"]，实际 ${JSON.stringify(m.Permissions)}`);
  if (Array.isArray(m.Hooks) && m.Hooks.includes('tool.run')) ok(`Hooks = ${m.Hooks.join(', ')}`);
  else bad('Hooks 必须含 tool.run');

  if (m.ExecutionTimeoutMs !== undefined) {
    const v = m.ExecutionTimeoutMs;
    if (Number.isInteger(v) && v >= 100 && v <= 120000) ok(`ExecutionTimeoutMs = ${v}（在 100–120000 内）`);
    else bad(`ExecutionTimeoutMs 越界：${v}`);
  }

  /* 4. 兼容声明 */
  console.log('\n代次兼容');
  const c = m.appCompatibility;
  const ep = m.appEpoch;

  if (c === undefined) {
    // 单代简写：本包策略为「仅旧 4.x」
    if (ep === undefined) {
      bad('既没声明 appCompatibility，也没声明 appEpoch，客户端无法判断适用代次');
    } else if (ep !== 1 && ep !== 2) {
      bad(`appEpoch 只允许 1 或 2（0 视同 1），当前 ${ep}`);
    } else if (ep === 1) {
      ok(`单代：appEpoch = 1（仅旧 4.x 体系）`);
      const min = String(m.MinAppVersion || '');
      if (!min.startsWith('4.')) {
        bad(`appEpoch=1 时 MinAppVersion 必须是 4.x，当前 ${min}`);
      } else if (cmpVersion(min, '4.1.2') < 0) {
        bad(`Api 4 插件最低需要 4.1.2，当前 ${min}`);
      } else {
        ok(`MinAppVersion = ${min}（满足 Api 4 的 4.1.2 下限）`);
      }
      ok('未声明正式代 1.x 兼容（符合单代策略）');
    } else {
      ok(`单代：appEpoch = 2（仅正式 1.x 体系）`);
    }
  } else if (!Array.isArray(c) || c.length < 1 || c.length > 2) {
    bad('appCompatibility 必须是 1–2 项数组');
  } else {
    const seen = new Set();
    let good = true;
    for (const it of c) {
      if (!it || (it.appEpoch !== 1 && it.appEpoch !== 2)) { bad(`appEpoch 非法：${it && it.appEpoch}`); good = false; continue; }
      if (seen.has(it.appEpoch)) { bad(`appEpoch ${it.appEpoch} 重复`); good = false; }
      seen.add(it.appEpoch);
      if (!/^\d+\.\d+\.\d+$/.test(it.minAppVersion || '')) { bad(`minAppVersion 非法：${it.minAppVersion}`); good = false; continue; }
      if (it.maxAppVersion !== undefined) {
        if (!/^\d+\.\d+\.\d+$/.test(it.maxAppVersion)) { bad(`maxAppVersion 非法：${it.maxAppVersion}`); good = false; }
        else if (cmpVersion(it.maxAppVersion, it.minAppVersion) < 0) { bad(`maxAppVersion 小于 minAppVersion（epoch ${it.appEpoch}）`); good = false; }
      }
      if (good) ok(`appEpoch ${it.appEpoch}：>= ${it.minAppVersion}${it.maxAppVersion ? ' 且 <= ' + it.maxAppVersion : ''}`);
    }
    if (good && c.length === 2) ok('双代兼容声明完整（旧代 + 正式代）');
    if (m.MinAppVersion && !String(m.MinAppVersion).startsWith('4.')) {
      bad(`声明了 appCompatibility 时，顶层 MinAppVersion 必须保留旧代 4.x，当前 ${m.MinAppVersion}`);
    } else {
      ok(`顶层 MinAppVersion = ${m.MinAppVersion}（旧代真实范围）`);
    }
    if (m.MaxAppVersion !== undefined) {
      bad(`不要写顶层 MaxAppVersion（${m.MaxAppVersion}）：它是旧代上限，会挡住 4.1.7+ 等更新客户端`);
    } else {
      ok('未设顶层 MaxAppVersion（不会误挡更新的旧代客户端）');
    }
  }

  /* 5. 源码 */
  console.log('\n源码 plugin.js');
  const jsEntry = entries.find((e) => e.name === 'plugin.js');
  const code = jsEntry.data;

  // 必须是无 BOM 的 UTF-8
  if (code[0] === 0xEF && code[1] === 0xBB && code[2] === 0xBF) bad('plugin.js 带 UTF-8 BOM');
  else ok('plugin.js 无 BOM');
  if (code.length <= LIMITS.code) ok(`${code.length} 字节，在 8 MiB 上限内`);
  else bad(`${code.length} 字节，超过 8 MiB`);

  const text = code.toString('utf8');
  if (text.includes('\uFFFD')) bad('含非法 UTF-8 替换字符，编码可能损坏');
  else ok('UTF-8 编码有效');

  if (/module\.exports|exports\./.test(text)) ok('CommonJS 导出存在');
  else bad('没有 CommonJS 导出');

  if (/require\(\s*['"]whale['"]\s*\)/.test(text)) ok("正确引用宿主 SDK require('whale')");
  else warn("没有 require('whale')，确认是否真的不需要宿主 SDK");

  // 语法检查：用 vm 只编译不执行
  try {
    new (require('node:vm').Script)(text, { filename: 'plugin.js' });
    ok('语法检查通过');
  } catch (e) {
    bad(`语法错误：${e.message}`);
  }

  done();
}

function done() {
  console.log('');
  if (fails) {
    console.log(`校验未通过：${fails} 个错误${warns ? `，${warns} 个警告` : ''}\n`);
    process.exitCode = 1;
  } else {
    console.log(`校验通过${warns ? `（${warns} 个警告）` : ''}。可投稿或本地安装。\n`);
  }
}

main();
