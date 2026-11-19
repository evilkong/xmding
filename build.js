#!/usr/bin/env node
'use strict';

/**
 * xmding 构建脚本 —— 只依赖 Node 内置模块，不需要 npm install。
 *
 *   node build.js            生成 dist/xmding-<version>.zip + 校验信息
 *   node build.js --local    额外部署到本机 WhaleGirl（相当于本地试装）
 *
 * 产物严格遵循《鲸鲸插件市场规范》的 Api 4 包要求：
 *   - ZIP 根目录只有两个文件：plugin.json、plugin.js
 *   - 包上限 16 MiB，代码上限 8 MiB，UTF-8、CommonJS
 *   - 不带 README / 安装器 / 子目录（那些会被视为不合规）
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const HERE = __dirname;
const SRC_FILES = ['plugin.json', 'plugin.js'];
const DIST = path.join(HERE, 'dist');

/* 规范上限（单位：字节） */
const LIMITS = {
  zip: 16 * 1024 * 1024,
  code: 8 * 1024 * 1024,
};

const GREEN = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const RED = (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const DIM = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

function die(msg) {
  console.error(`\n${RED('构建失败：')} ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------- 最小 ZIP 写入器 */

/**
 * 只用 zlib 生成标准 ZIP（deflate）。
 * 不引第三方库，保证构建环境干净可复现。
 */
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** DOS 时间戳：固定成 1980-01-01，保证构建可复现（同输入 → 同字节）。 */
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    // 压缩没变小就存原文
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // 本地文件头签名
    local.writeUInt16LE(20, 4);              // 需要版本 2.0
    local.writeUInt16LE(0x0800, 6);          // 标志：文件名 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // 无 extra

    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);    // 中央目录签名
    central.writeUInt16LE(20, 4);            // 创建版本
    central.writeUInt16LE(20, 6);            // 需要版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);            // extra
    central.writeUInt16LE(0, 32);            // comment
    central.writeUInt16LE(0, 34);            // 磁盘号
    central.writeUInt16LE(0, 36);            // 内部属性
    central.writeUInt32LE(0, 38);            // 外部属性
    central.writeUInt32LE(offset, 42);       // 本地头偏移

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);          // 中央目录结束签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/* ------------------------------------------------------------ 清单校验 */

function validateManifest(manifest, version) {
  const errs = [];
  const need = ['Id', 'Name', 'Author', 'Version', 'MinAppVersion', 'Description', 'ResultLabel', 'Api', 'Kind'];

  for (const key of need) {
    if (manifest[key] === undefined || manifest[key] === '') errs.push(`缺少必填字段 ${key}`);
  }

  // ID 规则：小写字母开头，只用小写字母、数字、短横线
  if (manifest.Id && !/^[a-z][a-z0-9-]*$/.test(manifest.Id)) {
    errs.push(`Id 必须小写字母开头且只含小写字母/数字/短横线，当前：${manifest.Id}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.Version || '')) {
    errs.push(`Version 必须是 x.y.z，当前：${manifest.Version}`);
  }
  if (String(manifest.Version) !== version) {
    errs.push(`plugin.json 的 Version（${manifest.Version}）与构建版本（${version}）不一致`);
  }
  if (manifest.Api !== 4) errs.push(`本包只面向 Api 4，当前 Api=${manifest.Api}`);

  if (!Array.isArray(manifest.Permissions) || manifest.Permissions.length !== 1
      || manifest.Permissions[0] !== 'system.full') {
    errs.push('Permissions 必须是 ["system.full"]');
  }
  if (!Array.isArray(manifest.Hooks) || manifest.Hooks.length === 0) {
    errs.push('Hooks 必须是非空数组');
  }
  if (manifest.Kind === 'tool' && !manifest.Hooks.includes('tool.run')) {
    errs.push('Kind=tool 时 Hooks 必须含 tool.run');
  }

  const ms = manifest.ExecutionTimeoutMs;
  if (ms !== undefined && (!Number.isInteger(ms) || ms < 100 || ms > 120000)) {
    errs.push(`ExecutionTimeoutMs 必须在 100–120000 之间，当前 ${ms}`);
  }

  // ---- 代次兼容 ----
  // 本包策略：只支持旧 4.x 体系（appEpoch 1），不支持正式代 1.x。
  // 单代包用整数 appEpoch 简写，不写 appCompatibility 数组；
  // 顶层 MinAppVersion 仍是旧代真实范围（4.x）。
  const compat = manifest.appCompatibility;
  const epoch = manifest.appEpoch;

  if (compat !== undefined) {
    if (!Array.isArray(compat) || compat.length < 1 || compat.length > 2) {
      errs.push('appCompatibility 必须是 1–2 项的数组');
    } else {
      const seen = new Set();
      for (const item of compat) {
        const e = item && item.appEpoch;
        if (e !== 1 && e !== 2) errs.push(`appEpoch 只允许 1 或 2，当前 ${e}`);
        if (seen.has(e)) errs.push(`appEpoch ${e} 重复`);
        seen.add(e);
        if (!item || typeof item.minAppVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(item.minAppVersion)) {
          errs.push('appCompatibility 每项必须有合法 minAppVersion');
        }
        if (item && item.maxAppVersion !== undefined) {
          if (!/^\d+\.\d+\.\d+$/.test(item.maxAppVersion)) {
            errs.push('maxAppVersion 格式非法');
          } else if (cmpVersion(item.maxAppVersion, item.minAppVersion) < 0) {
            errs.push(`maxAppVersion(${item.maxAppVersion}) 不能小于 minAppVersion(${item.minAppVersion})`);
          }
        }
      }
    }
    // 规范：顶层 MinAppVersion 必须保留「旧代」真实范围，不能写成 1.x
    if (manifest.MinAppVersion && !manifest.MinAppVersion.startsWith('4.')) {
      errs.push(`声明 appCompatibility 时，顶层 MinAppVersion 必须保留旧代范围（4.x），当前 ${manifest.MinAppVersion}`);
    }
    // 顶层 MaxAppVersion 是旧代上限，写死具体版本会把更新的旧客户端挡在外面。
    if (manifest.MaxAppVersion !== undefined) {
      errs.push(
        '不要写顶层 MaxAppVersion：它是旧代上限，会把 4.1.7+ 等更新客户端挡在外面；'
        + '需要限制上限请用 appCompatibility 里对应项的 maxAppVersion'
      );
    }
  } else {
    // 单代简写
    if (epoch === undefined) {
      errs.push('单代包必须声明 appEpoch（本包为 1，表示仅旧 4.x 体系）');
    } else if (epoch !== 1 && epoch !== 2) {
      errs.push(`appEpoch 只允许 1 或 2（0 视同 1），当前 ${epoch}`);
    } else if (epoch === 1) {
      // 旧代必须遵守 4.1.0 / 4.1.2 的最低版本约定
      const min = String(manifest.MinAppVersion || '');
      if (!min.startsWith('4.')) {
        errs.push(`appEpoch=1 时 MinAppVersion 必须是旧代 4.x，当前 ${min}`);
      } else if (cmpVersion(min, '4.1.2') < 0) {
        errs.push(`Api 4 插件最低需要 4.1.2，当前 MinAppVersion=${min}`);
      }
    } else if (epoch === 2) {
      const min = String(manifest.MinAppVersion || '');
      if (!min.startsWith('1.')) {
        errs.push(`appEpoch=2 时 MinAppVersion 必须是正式代 1.x，当前 ${min}`);
      }
    }
  }

  return errs;
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/* ---------------------------------------------------------------- 主流程 */

function main() {
  const deployLocal = process.argv.includes('--local');

  console.log(`\n${DIM('xmding 构建')}\n`);

  // 1) 读清单
  const manifestFile = path.join(HERE, 'plugin.json');
  if (!fs.existsSync(manifestFile)) die('缺少 plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    die(`plugin.json 不是合法 JSON：${err.message}`);
  }

  const version = String(manifest.Version || '');
  console.log(`  插件：${manifest.Id}  v${version}  Api ${manifest.Api}  ${manifest.Kind}`);

  // 2) 校验清单
  const errs = validateManifest(manifest, version);
  if (errs.length) {
    console.error(`\n${RED('清单不合规：')}`);
    for (const e of errs) console.error(`    ✗ ${e}`);
    die('请先修正 plugin.json');
  }
  console.log(`  ${GREEN('✓')} 清单校验通过`);

  // 3) 读源码
  const sourceFile = path.join(HERE, 'plugin.js');
  if (!fs.existsSync(sourceFile)) die('缺少 plugin.js');
  const source = fs.readFileSync(sourceFile, 'utf8');

  if (!source.trim()) die('plugin.js 是空的');
  const codeBytes = Buffer.byteLength(source);
  if (codeBytes > LIMITS.code) {
    die(`代码 ${codeBytes} 字节超过上限 ${LIMITS.code} 字节（8 MiB）`);
  }
  // 必须是 CommonJS
  if (!/require\s*\(|module\.exports|exports\./.test(source)) {
    die('plugin.js 看起来不是 CommonJS（缺少 require / module.exports / exports）');
  }
  console.log(`  ${GREEN('✓')} 源码 ${codeBytes} 字节，CommonJS`);

  // 4) 打包：根目录只有两个文件
  const entries = SRC_FILES.map((name) => ({
    name: name,
    data: fs.readFileSync(path.join(HERE, name)),
  }));
  const zip = zipStore(entries);

  if (zip.length > LIMITS.zip) {
    die(`包 ${zip.length} 字节超过上限 ${LIMITS.zip} 字节（16 MiB）`);
  }

  fs.mkdirSync(DIST, { recursive: true });
  const zipName = `${manifest.Id}-${version}.zip`;
  const zipPath = path.join(DIST, zipName);
  fs.writeFileSync(zipPath, zip);

  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  console.log(`  ${GREEN('✓')} 已生成 ${DIM('dist/' + zipName)}（${zip.length} 字节）`);
  console.log(`  ${GREEN('✓')} SHA-256 ${sha}`);

  // 5) 写校验信息（供投稿和自检使用）
  const meta = {
    id: manifest.Id,
    name: manifest.Name,
    author: manifest.Author,
    version: version,
    api: manifest.Api,
    kind: manifest.Kind,
    hooks: manifest.Hooks,
    permissions: manifest.Permissions,
    minAppVersion: manifest.MinAppVersion,
    maxAppVersion: manifest.MaxAppVersion,
    appCompatibility: manifest.appCompatibility,
    file: zipName,
    bytes: zip.length,
    sha256: sha,
    files: SRC_FILES,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DIST, `${manifest.Id}-${version}.json`),
    JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(`  ${GREEN('✓')} 已写入校验信息 dist/${manifest.Id}-${version}.json`);

  // 6) 可选：部署到本机做本地试装
  if (deployLocal) deployToLocal(manifest, source);

  console.log(`\n${GREEN('构建完成。')}\n`);
  console.log(`  安装包：${DIM(zipPath)}`);
  console.log(`  本地安装：鲸鲸 →「插件市场 → 从本地安装」选择该 ZIP\n`);
}

/** 把插件直接装到本机 WhaleGirl（等价于本地试装，便于回归测试）。 */
function deployToLocal(manifest, source) {
  const candidates = [
    process.env.WHALE_ROOT,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WhaleGirl'),
    'C:\\Program Files\\WhaleGirl',
  ].filter(Boolean);

  const root = candidates.find((d) => {
    try {
      return fs.statSync(path.join(d, 'server.js')).isFile()
        && fs.statSync(path.join(d, 'src', 'app.js')).isFile();
    } catch { return false; }
  });

  if (!root) {
    console.log(`  ${RED('!')} 没找到 WhaleGirl 根目录，跳过本地部署（可用 WHALE_ROOT 指定）`);
    return;
  }

  // 内核实际读取的 flow.json 结构与清单不同：它把源码内联进去。
  const flow = {
    id: manifest.Id,
    api: 4,
    kind: manifest.Kind,
    hooks: manifest.Hooks,
    permissions: manifest.Permissions,
    executionTimeoutMs: manifest.ExecutionTimeoutMs || 30000,
    settings: {},
    javascript: source,
  };

  const pluginsDir = path.join(root, 'data', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const flowPath = path.join(pluginsDir, `${manifest.Id}.flow.json`);
  fs.writeFileSync(flowPath, JSON.stringify(flow), 'utf8');

  // hash 必须等于 flow.json 的磁盘字节
  const hash = crypto.createHash('sha256').update(fs.readFileSync(flowPath)).digest('hex');

  fs.writeFileSync(path.join(pluginsDir, `${manifest.Id}.flow-grant.json`),
    JSON.stringify({ enabled: true, fullAccess: true, hash, settings: {} }), 'utf8');
  fs.writeFileSync(path.join(pluginsDir, `${manifest.Id}.enabled`), '', 'utf8');

  fs.mkdirSync(path.join(pluginsDir, `${manifest.Id}.data`), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, `${manifest.Id}.data`, 'plugin.js'), source, 'utf8');

  console.log(`  ${GREEN('✓')} 已部署到本机 ${DIM(root)}`);
  console.log(`    ${DIM('授权 hash')} ${hash}`);
}

main();
