# 小咪叮 · 鲸鲸主动发消息插件

按群名 / 人名 / 备注 / wxid 或会话 ID，向指定群聊或个人主动发消息。

| 项 | 值 |
|---|---|
| 插件 ID | `xmding`（显示名「小咪叮」） |
| 作者 | atroy |
| 版本 | 1.0.1 |
| Api | 4（JavaScript，最小客户端 4.1.2） |
| Kind | `tool` |
| Hooks | `tool.run` |
| 权限 | `system.full` |
| 兼容 | 旧代 4.1.2+ ／ 正式代 1.0.0+（双兼容） |

---

## 一、先说一个必须知道的规范冲突

你上一版要的「离线安装包」里带了 `README.md` 和 `安装.cmd`，但**新版规范不允许这样**：

> ZIP 根目录仅两个文件：`plugin.json` 和 `plugin.js`。包上限 16 MiB，代码上限 8 MiB，UTF-8、CommonJS。

所以按你的要求「按规范整理」，本版做了拆分：

| 产物 | 内容 | 用途 |
|---|---|---|
| `dist/xmding-1.0.1.zip` | 仅 `plugin.json` + `plugin.js` | **符合规范的安装包**，走「插件市场 → 从本地安装」 |
| 本 README | 说明文档 | 独立文件，不塞进 ZIP |
| `build.js` / `verify.js` / `smoke.js` | 构建、校验、回归 | 开发用，不随包分发 |

**如果你更需要「双击就能装」的离线包**（含安装器、能绕过插件市场直接写入 `data/plugins`），那是另一种形态，同样保留在仓库里，但不能投稿、也不符合 Api 4 包规范。需要哪种告诉我，两者可以并存。

---

## 二、安装

### 方式 A：走鲸鲸插件市场（推荐，符合规范）

1. 鲸鲸 →「插件市场 → 从本地安装」
2. 选 `dist/xmding-1.0.1.zip`
3. 在「已安装」卡片点「启用」
4. **启用后需重启内核**，插件才会响应请求

### 方式 B：本地试装（开发调试）

```bash
node build.js --local
```

直接写入 `<WhaleGirl>/data/plugins/`，等价于本地安装，便于反复回归。
会自动计算授权 hash、生成 `flow.json` / `flow-grant.json` / `.enabled`。

---

## 三、调用

地址 `http://127.0.0.1:8787/api/plugins/run`，认证头 `x-bot-token`（取自 `config.json` → `gateway.wechat.inboundToken`）。

### send · 发消息

```json
{ "id": "xmding", "input": { "to": "久客研发中心", "text": "开会了" } }
```

| 字段 | 说明 |
|---|---|
| `to` | 群名 / 人名 / 备注 / wxid / `xxx@chatroom`，**必须唯一命中** |
| `chatId` | 直接给会话 ID，跳过名称匹配（最稳） |
| `text` | 正文，≤ 4000 字 |
| `chatType` | `group` / `private`，仅影响搜索范围 |
| `delivery` | `text`（默认）/ `voice` / `image`（image 需 `file` 绝对路径） |
| `dryRun` | `true` = 只解析目标不发送 |

### status · 查回执

```json
{ "id": "xmding", "input": { "action": "status", "id": "<send 返回的 id>" } }
```

### list · 搜联系人 / 群

```json
{ "id": "xmding", "input": { "action": "list", "q": "研发", "chatType": "group" } }
```

### ping · 探活

```json
{ "id": "xmding", "input": { "action": "ping" } }
```

### curl 范例

```bash
# 纯 ASCII 可内联
curl -s -X POST "http://127.0.0.1:8787/api/plugins/run" \
  -H "x-bot-token: <token>" -H "Content-Type: application/json" \
  -d '{"id":"xmding","input":{"action":"ping"}}'

# 含中文用文件传，避免编码问题
cat > /tmp/xm.json <<'EOF'
{"id":"xmding","input":{"to":"久客研发中心","text":"开会了","dryRun":true}}
EOF
curl -s -X POST "http://127.0.0.1:8787/api/plugins/run" \
  -H "x-bot-token: <token>" -H "Content-Type: application/json" \
  --data-binary @/tmp/xm.json
```

> **Windows PowerShell 5.1 注意**：它会剥掉内联 `-d` 两侧的引号，`{"id":...}` 变成 `{id:...}`，服务端报 `JSON 格式错误`。用 `curl.exe --% ...` 停止解析，或改走文件。`Set-Content -Encoding UTF8` 还会写入 BOM，同样会失败，请用 `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))`。

---

## 四、发送成功怎么判断

`send` 返回 `queued: true` **只代表入队**，不代表送达。必须查 `status`：

| status | 含义 |
|---|---|
| `queued` / `pending` | 已入队，桥接还没取 |
| `sending` | 桥接正在发 |
| `submitted` / `done` | **发出去了**（`confirmed: true`） |
| `unconfirmed` | 未确认，按策略不自动重发 |
| `failed` / `expired` / `cancelled` | 失败 / 过期 / 取消 |

正常是 `queued → pending → submitted`，几秒到十几秒。

---

## 五、发送链路

本插件不操作微信窗口，只把消息交给内核的主动发送队列：

```
whale.sendText() → reminders 入队 → 桥接 /api/reminders/due → 零焦点通道 → 微信
```

所以它依赖：

- **内核在线**：`http://127.0.0.1:8787`（`/healthz` 探活）
- **桥接在线**：`/api/status` 里 `gateways[0].bridge.online === true`
- **微信窗口非最小化**：最小化时零焦点通道返回 `minimized`
- **插件总开关**：`config.json` 的 `features.javascriptPlugins: true`

---

## 六、双代兼容声明

```json
"MinAppVersion": "4.1.2",
"MaxAppVersion": "4.1.6",
"appCompatibility": [
  { "appEpoch": 1, "minAppVersion": "4.1.2" },
  { "appEpoch": 2, "minAppVersion": "1.0.0" }
]
```

按规范要点：

- 顶层 `MinAppVersion` / `MaxAppVersion` **保留旧代真实范围**（4.x），不能改成 1.x，供已发布旧客户端读取
- 新客户端优先读 `appCompatibility` 数组，先比代次再比版本，**不跨代比较 4.x 与 1.x**
- 数组 1–2 项，`appEpoch` 只允许 1 或 2，同代不可重复
- 市场条目与包内声明必须一致（含顺序）——本包暂未投稿，投稿时需保持同步

> 功能插件的跨代兼容**不由宿主自动推断**，需作者在两代分别试装。本包的双兼容是按规范声明并已在 4.1.7.1 上验证；正式代 1.x 客户端我这里没有，**未做实机验证**，投稿前请在两代各试装一次。

---

## 七、开发

```bash
node build.js             # 生成 dist/xmding-<version>.zip + 校验信息
node build.js --local     # 额外部署到本机，便于回归
node verify.js            # 独立校验包结构 / 清单 / 兼容声明 / 源码
node smoke.js             # 功能回归（对运行中的内核发真实请求）
```

`build.js` 与 `verify.js` 的 ZIP 解析是**两套独立实现**，避免「自己写错自己验过」。
构建固定 DOS 时间戳且不写时间字段，**同输入产生完全相同的字节**，便于核对 SHA-256。

### 已通过的检查

| 检查 | 结果 |
|---|---|
| 清单必填字段 / ID 规则 / 版本格式 | 通过 |
| 包结构（仅两个文件、无子目录） | 通过 |
| 体积（包 6.8 KB / 代码 16 KB） | 远低于 16 MiB / 8 MiB |
| `appCompatibility` 结构、代次、范围 | 通过 |
| UTF-8 编码、无 BOM、CommonJS 导出 | 通过 |
| 语法编译（vm 只编译不执行） | 通过 |
| 构建可复现（两次 SHA-256 相同） | 通过 |
| 功能回归 24 项 | 全通过 |
| 真实发送到微信并确认送达 | 通过 |

---

## 八、安全

`system.full` 意味着插件以当前 Windows 用户权限执行，可访问网络、文件、系统命令和主程序全部 API。**JavaScript 不是沙箱**。

本插件实际用到的能力仅：`require('whale')` 的 `api()` / `sendText()` / `sendVoice()` / `sendImage()` / `delivery()`。源码 `plugin.js` 完全可读，安装前建议自行审阅。
