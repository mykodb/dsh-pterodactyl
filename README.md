# dsh-pterodactyl

给 DSH 用的 Pterodactyl 面板集成插件。由模型直接查状态、做电源操作、管备份与文件；面板网页本身的日常操作请直接去面板网站。

配置入口在 DSH 的「插件 → Pterodactyl 面板」详情页里（`plugins.bundle.config` 槽位），不在侧栏，也没有单独面板。

## 安装

```bash
dsh plugin --profile web add dsh-pterodactyl
```

`--profile` 必须写在子命令前面。装完**重启 dsh web 进程**，然后到「插件 → Pterodactyl 面板」的详情页填面板地址和 API Key。

> **API Key 需要 Pterodactyl Client API 权限**（面板 → Account → API Credentials 创建）。这是账号级 key，不是 Application 的管理员 key。

---

## 它能做什么

十个工具，覆盖 Pterodactyl Client API 能给的全部读写能力。所有请求都由 Host 侧代发，API Key 不进 Agent 上下文、也不下发浏览器。

### 服务器

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `pterodactyl_servers` | `server` 可选 | 不传：列出全部服务器（identifier、名字、状态、限额）。传了：读该服务器实时用量（状态、CPU、内存、磁盘、网络收发、运行时长） |

> **新会话不知道 identifier 时，先用不带参数的 `servers`。** 这是唯一的“入口”工具——别的工具都要 identifier，这个不要。

### 电源

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `pterodactyl_power` | `server` + `signal` | `start` / `stop` / `restart` / `kill` |

`stop` 与 `kill` 必须额外传 `confirm: true`，并且调用时还会向会话发起一次人工授权；用户不同意就不执行。

### 控制台

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `pterodactyl_console` | `server` + `command` + 可选 `waitMs` | 在服务器控制台执行一条命令，取回这段时间的输出 |

`command` 不带前导斜杠，例如 `list` / `say hi` / `tps`。`waitMs` 默认 3000，范围 500–60000——它只是命令发出后等回显的窗口，**不是日志**；要看日志请读 `/logs/latest.log`。

实现上连的是服务器自己的 WebSocket 控制台：先 `GET /servers/{id}/websocket` 换票据，连上 wings 的 wss，`auth` 握手后发 `send command`，收集这段时间的 `console output` 行再返回，ANSI 颜色码会剥掉。**每次调用是一条短连接，命令真实执行。**

- 含换行的多行命令会被拒绝，一次只能发一条。
- 单行超 2000 字符会被截，最多保留 120 行，超出时标 `truncated` 并丢掉最老的。
- `stop` / `kill` / `op` / `deop` / `ban` / `ban-ip` / `pardon` / `pardon-ip` 必须额外传 `confirm: true`，并额外经过人工授权。

### 备份

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `pterodactyl_backups` | `action` + `server` | `list` 列出 / `create` 新建（可选 `name`）/ `delete` 删除（需 `backup` uuid） |

备份只留在服务器上，不提供下载到本机的能力——需要的话去面板操作。`delete` 不可恢复，调用时会先发起一次人工授权，说明里带上备份名与大小。

### 文件（六个独立工具）

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `pterodactyl_files_list` | `server` + 可选 `path` | 列目录 |
| `pterodactyl_files_read` | `server` + `path` | 读文本文件 |
| `pterodactyl_files_write` | `server` + `path` + `content` 或 `oldText`/`newText` | 写入（两种模式，见下） |
| `pterodactyl_files_upload` | `server` + `sourcePath` + 可选 `path` / `fileName` | 从本机上传 |
| `pterodactyl_files_download` | `server` + `path` + 可选 `targetPath` | 下载到本机 |
| `pterodactyl_files_delete` | `server` + `path` + `names` + `confirm` | 删除，支持批量；需 `confirm: true` 并经人工授权 |

**`write` 的两种模式**：

- 给 `oldText` → 局部替换。Host 自己读全文、校验片段唯一、替换一次再整体写回，**模型不需要提供全文**；`newText` 传空串表示删掉该片段。
- 不给 `oldText` → 用 `content` 整体覆盖。

两种模式都会自动逐级创建不存在的父目录，所以不需要单独建目录。

**上传/下载都是流式的**，字节不经过 Agent 上下文、不整体进内存：上传上限 2 GiB，下载默认落到 `~/Downloads`（可用 `targetPath` 指定文件或目录），同名文件直接覆盖并在返回里标 `overwritten`。

---

## 边界

| 项 | 限制 |
| --- | --- |
| 文本读取/写入 | 512 KB，超了会提示改用 `download` |
| 上传/下载 | 2 GiB，流式 |
| 二进制读取 | `read` 会拒绝（含 NUL 字节或大量替换字符），提示改用 `download` |
| 路径越界 | 做归一化，`..` 逃不出服务器根目录 |
| 控制台 | 单行 2000 字符、单次最多 120 行 |

**做不到的**：

- 创建 / 删除服务器本体。那属于 Application API，需要管理员 key，Client API 没有这些接口。
- 编辑二进制文件内容。文本编辑器走 JSON，仍受 512 KB 限制——但**上传/替换**二进制文件可以，用 `upload`。
- 下载备份。见上面「备份」一节。

---

## 配置

profile 的 `cordis.patch.yml` 里只写这几项：

| 键 | 说明 |
| --- | --- |
| `baseUrl` | 面板根地址，如 `https://panel.example.com`；可带或不带 `/api/client`，插件会自动补齐 |
| `apiKeyRef` | API Key 的凭证名，默认 `PTERODACTYL_API_KEY` |
| `requestTimeoutMs` | 单个 HTTP 请求超时，默认 `15000` |
| `allowInsecure` | 自签证书时设为 `true`（跳过 TLS 校验），默认 `false` |
| `approvalPolicy` | 危险操作的人工授权策略，默认 `strict`；`fallback` 见下 |

### 人工授权（危险操作）

删文件、删备份、`stop`/`kill`、控制台危险命令这四类操作，除了调用方要传 `confirm: true`，插件还会通过 `ctx.approval.request()` 向会话发起一次人工授权。用户点允许才执行，**授权只对这一次有效**，不会沉淀成以后自动通过的规则。

`approvalPolicy` 只影响一种情况——当前环境根本没有可用的授权应答方（比如 CLI、无人值守）：

| 值 | 行为 |
| --- | --- |
| `strict`（默认） | 视为拒绝，操作不执行。宁可不删，也不默默删掉 |
| `fallback` | 退回 `confirm` 语义放行，并在返回里说明本次未经人工确认 |

用户主动**拒绝或取消**在两种策略下都一律拦截，`fallback` 不能绕过。

**界面入口**：DSH 侧栏「插件」→ 打开 **Pterodactyl 面板** 的详情页，描述下方就是「连接设置」——填面板地址、粘贴 API Key、保存即可（写入凭证库，不回显明文）。摘要行会显示「已连接 / 未配置」。

也可以直接改文件：

```bash
# baseUrl：编辑 ~/.dsh/profiles/web/cordis.patch.yml 里 dsh-pterodactyl 的 config.baseUrl
# API Key：在 ~/.dsh/.credentials.yaml 的 refs 下写 PTERODACTYL_API_KEY: ptlc_xxx
```

**凭据解析顺序**：每次调用工具都重新解析，先 **DSH 凭证库**，再环境变量 `apiKeyRef`。所以改完 key 下次调用就生效，无需重启。

> DSH 凭证库的 `refs` 区是明文键值、靠文件权限（600）保护，并非加密保险箱；`records` 区存结构化授权。

---

## 架构

- `entry.js`（Host）：`inject = ['tools', 'webServer']`；注册 Agent 工具；在 `/dsh-pterodactyl` 前缀上注册设置路由（`status` / `settings` / `settings/save` / `settings/clear-key`），只服务插件详情页的设置表单。
- `client.js`（Client）：只注册 `plugins.bundle.config` 槽位（key = `dsh-pterodactyl`），提供插件详情页的设置表单。
- API Key 只在 Host 侧读取和使用，既不进 Agent 上下文，也不下发到浏览器——这是整个插件的核心设计。

用到的面板 API：

- 服务器：`GET /api/client`（列表）、`GET /api/client/servers/{id}/resources`、`POST /api/client/servers/{id}/power`
- 备份：`GET|POST /api/client/servers/{id}/backups`、`DELETE /api/client/servers/{id}/backups/{uuid}`
- 文件：`GET .../files/list?directory=`、`GET .../files/contents?file=`、`POST .../files/write?file=`、`POST .../files/upload?directory=`（multipart，字段 `files`）、`POST .../files/create-folder`、`POST .../files/delete`
- 控制台：`GET /api/client/servers/{id}/websocket` + wings wss

---

## 许可证

MIT
