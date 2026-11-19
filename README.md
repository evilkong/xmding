# 小咪叮 · 鲸鲸主动发消息插件

按群名 / 人名 / 备注 / wxid 或会话 ID，向指定群聊或个人主动发消息。

| 项 | 值 |
|---|---|
| 插件 ID | `xmding`（显示名「小咪叮」） |
| 作者 | atroy |
| 版本 | 1.0.3 |
| Api | 4（JavaScript，最小客户端 4.1.2） |
| Kind | `tool` |
| Hooks | `tool.run` |
| 权限 | `system.full` |
| 兼容 | 旧 4.x 体系 4.1.2+ |

---

## 安装

从「插件市场 → 从本地安装」选择 `dist/xmding-1.0.3.zip`，然后在「已安装」卡片点「启用」。

**启用后需重启内核**，插件才会响应请求。

<details>
<summary>本地试装（开发调试用）</summary>

```bash
node build.js --local
```

直接写入 `<WhaleGirl>/data/plugins/`，自动计算授权 hash 并生成 `flow.json` / `flow-grant.json` / `.enabled`。

</details>

---

## 调用

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

> **Windows PowerShell 5.1**：它会剥掉内联 `-d` 两侧的引号，`{"id":...}` 变成 `{id:...}`，服务端报 `JSON 格式错误`。用 `curl.exe --% ...` 停止解析，或改走文件。`Set-Content -Encoding UTF8` 还会写入 BOM，同样失败，请用 `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))`。

---

## 判断发送成功

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

## 发送链路

本插件不操作微信窗口，只把消息交给内核的主动发送队列：

```
whale.sendText() → reminders 入队 → 桥接 /api/reminders/due → 零焦点通道 → 微信
```

依赖条件：

- **内核在线**：`http://127.0.0.1:8787`（`/healthz` 探活）
- **桥接在线**：`/api/status` 里 `gateways[0].bridge.online === true`
- **微信窗口非最小化**：最小化时零焦点通道返回 `minimized`
- **插件总开关**：`config.json` 的 `features.javascriptPlugins: true`

---

## 兼容声明

本包只兼容旧 4.x 体系，不声明正式代 1.x：

```json
"MinAppVersion": "4.1.2",
"appEpoch": 1
```

单代包用整数 `appEpoch` 简写。客户端先比代次、再比范围，不跨代比较 4.x 与 1.x。

不设版本上限（最低 4.1.2，向上不限）。需要限制上限时用数组项的 `maxAppVersion`：

```json
"appCompatibility": [
  { "appEpoch": 1, "minAppVersion": "4.1.2", "maxAppVersion": "4.1.9" }
]
```

已在 **4.1.7.1** 实机验证安装、启用、发送与回执。

---

## 开发

```bash
node build.js             # 生成 dist/xmding-<version>.zip + 校验信息
node build.js --local     # 额外部署到本机，便于回归
node verify.js            # 独立校验包结构 / 清单 / 兼容声明 / 源码
node smoke.js             # 功能回归（对运行中的内核发真实请求）
```

`build.js` 与 `verify.js` 的 ZIP 解析是两套独立实现，避免「自己写错自己验过」。构建固定时间戳，同输入产生相同字节，便于核对 SHA-256。

安装包根目录只含 `plugin.json` 和 `plugin.js` 两个文件（上限 16 MiB，代码 8 MiB，UTF-8、CommonJS）。

---

## 安全

`system.full` 意味着插件以当前 Windows 用户权限执行，可访问网络、文件、系统命令和主程序全部 API。**JavaScript 不是沙箱**。

本插件实际用到的能力仅：`require('whale')` 的 `api()` / `sendText()` / `sendVoice()` / `sendImage()` / `delivery()`。源码 `plugin.js` 完全可读，安装前建议自行审阅。
