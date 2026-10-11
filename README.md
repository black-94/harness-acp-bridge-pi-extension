# @black942026/harness-acp-bridge-pi-extension

将 [@black942026/harness-acp-bridge-server](https://github.com/black-94/harness-acp-bridge-server)
接入 Pi 的**薄 HTTP 客户端**扩展。

扩展直接 `POST /api/<name>` 连接服务端，**不经过 MCP**，也不启动 harness。若配置的
loopback 地址上没有兼容服务，扩展会按需启动已安装的 server 包并复用该实例。

**服务端异步，Pi 接口同步**：`acp_send_message` 提交后在**同一个工具调用内**等待终态，期间
权限 / 信息反向请求弹窗，回答后继续等待；**不会结束工具调用、发送新用户消息或启动新模型回合，
也不自动批准权限。**

```text
Pi 工具调用（保持执行）
  ├─ POST send_message → message_id（服务端异步受理）
  ├─ 轮询 message_status / live_output
  ├─ waiting_input → ask_user / 原生 select、input 弹窗 → answer_question → 继续原调用
  └─ completed / failed / cancelled → 返回终态 message_status（result 即最终答案）
```

ACP 协议、SSH/Docker 启动、认证、会话状态、持久化与调度全部由服务端负责。

## 安装与快速启动

要求 macOS / Linux、Node.js ≥ 22.19，以及支持扩展工具 `ctx.executeTool()` 的当前 Pi。

```bash
pi install npm:@black942026/harness-acp-bridge-pi-extension
```

服务端作为运行依赖自动安装（HTTP 五层 server，非旧的 socket 版本）。**无需全局安装服务端，也
无需手工构建**：只要配置好服务 URL，第一次调用时扩展会自动拉起本地服务。参考
[服务端配置示例](https://github.com/black-94/harness-acp-bridge-server/blob/main/config.example.yaml)
准备 YAML 配置后：

```bash
HARNESS_ACP_BRIDGE_CONFIG=/absolute/path/to/config.yaml pi
```

临时加载：`pi -e npm:@black942026/harness-acp-bridge-pi-extension`。配置好 harness 命令、
模型与认证后再使用；不要未经检查直接启用 `yolo` 权限模式。

## 配置

复制 [config.example.json](config.example.json) 保存为：

- 全局：`~/.pi/agent/harness-acp-bridge.json`
- 项目：`<cwd>/.pi/harness-acp-bridge.json`（覆盖全局同名项）
- 自定义位置：`PI_ACP_BRIDGE_SETTINGS=/path/settings.json`，只读取这个文件

`PI_CODING_AGENT_DIR` 可替换全局 agent 目录。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8787` | 服务端地址；仅 `http`/`https`，不含凭据、查询串或片段 |
| `requestTimeoutMs` | `900000` | 单次 HTTP 请求超时，需覆盖创建 / 认证的耗时 |
| `interactionTimeoutMs` | `60000` | 每个交互问题的超时 |
| `pollIntervalMs` | `500` | 状态 / 输出轮询间隔 |
| `autoStart` | `true` | 服务不可达时是否按需启动本地服务 |
| `serverEntry` | 已安装依赖 | 启动本地服务时加载的 server 模块或路径。相对路径按 `ctx.cwd` 解析，`file:` URL 原样使用；必须指向导出 `HarnessHttpServer`/`loadConfig` 的 server 入口，**不是** `dist/main.js` 之类的 CLI |
| `configPath` | 环境变量 / 默认 | 传给所启动服务的 YAML 配置路径 |
| `startupTimeoutMs` | `30000` | 等待所启动服务响应 `ping` 的上限 |

**不接受 `command`/`args`/`env`/`cwd` 等启动透传字段**：扩展只连接服务，不注入命令或环境。
未知字段直接报错，不静默忽略。`HARNESS_ACP_BRIDGE_CONFIG` 仍被沿用为服务端配置路径。

> **迁移**：旧版本用 `command`/`args`/`env` 指定如何 `spawn` 服务端 CLI。这些字段已移除且会被
> 拒绝；请改为配置 `baseUrl`（并按需 `autoStart`/`serverEntry`/`configPath`）。旧的 socket
> server 与本扩展不再兼容。

## 本地服务生命周期

1. `ping` 配置的 `baseUrl`；返回 `protocol_version: 2` 的服务被直接复用。
2. 若地址被占据但**不是**兼容的 bridge 服务（错误信封、协议版本不符、或非 JSON 监听者），
   扩展报 `incompatible_server` 并且**不**另起服务——外来服务不会被当作“不存在”。
3. 若无人监听、`autoStart` 为真，且地址是 **loopback**，扩展才启动服务。非 loopback 地址绝不
   本地 spawn，也不经 SSH 启动。
4. 启动由客户端目录下按地址加锁串行化，随后重新探测，两个客户端并发启动同一实例会收敛到一个
   服务（服务端自身的 `state_dir` 锁与端口绑定是最终兜底）。
5. 所启动服务以 detached、无继承 stdio 方式运行：它独立于客户端存活，且**客户端永不主动 kill
   它**，因此不会误伤其他客户端的会话或复用实例。它的 pid 与日志记在
   `<client dir>/servers.json`（默认 `~/.harness-acp-bridge-client`），诊断来自其日志且已脱敏。
6. `shutdown`/`reload` 只释放客户端自身的连接，**不关闭已有服务端会话，也不停止复用实例**。

## 工具

注册 12 个 `acp_` 工具（与服务端同名）加 `acp_wait`：`acp_ping`、`acp_search_harness`、
`acp_create_session`、`acp_close_session`、`acp_authenticate`、`acp_auth_status`、
`acp_set_session_options`、`acp_send_message`、`acp_cancel_message`、`acp_message_status`、
`acp_live_output`、`acp_answer_question`，外加上面的 `acp_wait`。

- **`acp_send_message`**：提交后在同一调用内同步等待终态（与 `acp_wait` 相同语义）。
- **`acp_wait`**：只等待已知的 `session_id`/`message_id`，不重复提交；用于 MCP/重载后恢复、无 UI
  场景回答后继续等待。
- `acp_live_output` 使用 `cursor`/`limit`/`wait_ms`；把 `next_cursor` 原样回传，始终排空
  `has_more`（即使 `terminal: true`），按 `seq`/`type` 拼接 `complete: false` 片段。

推荐顺序：`acp_create_session` → `acp_send_message`（内部同步等待并弹窗）→ 结束；不再使用时
`acp_close_session`。服务端仍只接受每会话一个非终态消息，`busy` 等错误原样报告；客户端不排队、
不 steer、不重试。网络中断后提交可能已生效，用同一 `idempotency_key` 重试可避免重复。

## 反向交互

1. 在原工具执行上下文中，有可调用的 `ask_user` 时经 `ctx.executeTool()` 调用；否则用 Pi 原生
   `ctx.ui.select/input`（TUI 弹窗；RPC 经 Extension UI 协议）。
2. 权限选项按索引精确映射回 `optionId`；拒绝选项原样选择，不推测、不默许。
3. 信息 / form elicitation 的对象字段生成输入或选择题，数字 / 布尔 / JSON 还原类型并做 JSON
   Schema 校验；无法拆分的表单要求输入完整 JSON 对象。默认值仅作提示，不静默提交。
4. 弹窗期间仍持续检查服务端状态；远端结束或请求过期会关闭旧弹窗，提交答案前再次核对
   `request_id`，防止迟到答案。多会话弹窗串行。
5. `ask_user` 采用 [pi-ask-user](https://github.com/black-94/pi-ask-user) 的结构化结果契约；
   人类可读文本不会被当作答案。取消 / 超时不会二次提问；只有 UI 尚未启动的
   unavailable/not_initialized 可回退到原生 UI。

### 无 UI、取消与输出

- print/JSON 等无 UI 模式遇到反向请求时返回 `waiting_input` 及原始 `questions`，不批准也不伪造。
  调用 `acp_answer_question` 后再 `acp_wait`。
- 关闭弹窗 → `answer: cancel`；到期 → `answer: timeout`；服务端决定继续还是取消消息。
- 中止 Pi 的等待工具（工具取消 / `signal`）→ 调用 `cancel_message` 取消当前远端消息。
- **预览仅用于 UI**：等待期间通过工具更新的 `content: []` + `details.preview` 传递预览，并由
  `acp_send_message`/`acp_wait` 的自定义 `renderResult` 渲染（Pi 默认不展示 `details`；终态排空剩余
  分页后也会刷新一次 UI）。预览**不进入**模型上下文，也**不**出现在 `send_message`/`wait` 最终返回的
  `content`、`structuredContent` 或可持久化数据里。最终答案来自 `message_status.result`；需要增量输出时
  显式调用 `acp_live_output`。
- `failed` 终态作为工具错误返回。超过 20,000 字符的结果写入权限 0600 的临时 JSON 文件，工具文本
  附路径，结构化结果保留完整数据。
- shutdown/reload 停止本地轮询、关闭弹窗，不隐式关闭服务端会话、不停止复用服务；分支内已保存的
  未完成 `message_id` 会在重载后恢复监控。

## 开发与验证

```bash
npm run dev:setup         # 干净安装 + Pi 开发依赖安全修补
npm run check             # 类型检查 + 测试（含真实 server + mock harness 端到端）
npm audit --omit=dev
npm pack --dry-run
```

`npm run check` 会按需启动**真实的已安装 HTTP server**与 server 仓库的 mock ACP harness（不调用
真实模型、不用 Docker/SSH），驱动提交 / 同步等待 / 结果 / 权限弹窗 / 输出分页 / 取消 / 无 UI /
shutdown 不杀复用实例等链路。用 `ACP_BRIDGE_SERVER_DIR` 指向 server 检出以提供 mock harness
fixture（默认 `../server`）。

本扩展以 TypeScript 源码发布，由 Pi 加载，无需 `dist`。`pi-package` 用于扩展目录发现，
`pi-extension` 标识扩展类型；Pi 提供的包仅声明为 peerDependencies。

Pi `1.0.0` 自带 shrinkwrap，将开发依赖 `brace-expansion` 锁在有漏洞的 `5.0.9`；`npm run
dev:setup` 在 `npm ci --ignore-scripts` 后运行 `fix:dev-deps` 修补该开发依赖（不进入发布包、不
改全局 Pi、不在用户安装时运行）。

## License

MIT
