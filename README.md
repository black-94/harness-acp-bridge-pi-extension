# @black942026/harness-acp-bridge-pi-extension

将 [@black942026/harness-acp-bridge-server](https://github.com/black-94/harness-acp-bridge-server) 接入 Pi 的薄客户端扩展。

**服务端异步，Pi 接口同步**：发送消息后在原工具调用中轮询，直到消息终态。期间权限 / 信息反向请求直接弹窗；回答通过 `answer_question` 回传后继续等待。**不会为了提问结束工具调用、发送新用户消息或启动新模型回合，也不会自动批准权限。**

```text
Pi 工具调用（保持执行）
  ├─ MCP send_message → message_id
  ├─ 轮询 message_result / live_output
  ├─ waiting_input → ask_user / 原生 select、input 弹窗
  │                  └─ answer_question → 继续原调用
  └─ completed / failed / cancelled → 返回最终结果
```

扩展只负责 MCP 连接、轮询、结果呈现与交互适配。ACP 协议、SSH/Docker 启动、认证、会话状态、持久化及调度全部由服务端负责。

## 安装与快速启动

要求 macOS / Linux、Node.js ≥ 22.19，以及支持扩展工具 `ctx.executeTool()` 的当前 Pi。

从 npm 安装：

```bash
pi install npm:@black942026/harness-acp-bridge-pi-extension
```

服务端作为运行依赖自动安装，默认通过当前 Node 启动依赖包内的 CLI，**无需全局安装服务端，也无需手动构建**。参考[服务端配置示例](https://github.com/black-94/harness-acp-bridge-server/blob/main/config.example.yaml)准备 YAML 配置，然后启动 Pi：

```bash
HARNESS_ACP_BRIDGE_CONFIG=/absolute/path/to/config.yaml pi
```

临时加载（不写 Pi 安装配置）：

```bash
HARNESS_ACP_BRIDGE_CONFIG=/absolute/path/to/config.yaml \
pi -e npm:@black942026/harness-acp-bridge-pi-extension
```

配置好服务端的 harness 命令、模型与认证后再使用。不要未经检查直接启用 `yolo` 权限模式。

本扩展自己建立 MCP 连接，**不需要**在 Pi 的 `mcp.json` 重复注册同一个服务。连接发生在 `session_start`；失败会提示，修好配置后可以 `/acp-connect` 重试。修改已经读取的扩展配置需要 `/reload`。

## 配置

复制 [config.example.json](config.example.json)，修改服务端 YAML 配置的绝对路径，保存为：

- 全局：`~/.pi/agent/harness-acp-bridge.json`
- 项目：`<cwd>/.pi/harness-acp-bridge.json`（覆盖全局同名项）
- 自定义位置：环境变量 `PI_ACP_BRIDGE_SETTINGS=/path/settings.json`，只读取这个文件

`PI_CODING_AGENT_DIR` 可替换全局 agent 目录。项目配置可以指定可执行程序，只在可信项目中使用。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `command` | 当前 Node + 依赖包内 CLI | 显式指定时替换默认启动方式，例如 `harness-acp-bridge` 或 `node` |
| `args` | `[]` | 默认作为依赖包 CLI 的参数；显式配置 command 时作为该命令的完整 argv；不经过 shell |
| `env` | `{}` | 服务进程环境变量；逐项合并 |
| `cwd` | Pi 工作目录 | 服务进程工作目录；相对路径相对于 Pi 工作目录 |
| `pollIntervalMs` | `500` | 进度与反向请求轮询间隔 |
| `requestTimeoutMs` | `900000` | 单次 MCP 请求超时，需覆盖创建 / 认证的耗时 |
| `interactionTimeoutMs` | `60000` | 每个交互问题的超时 |

环境变量优先：

- `HARNESS_ACP_BRIDGE_SERVER`：服务端 `dist/cli.js` 路径，将 command/args 替换为当前 Node + 该脚本。
- `HARNESS_ACP_BRIDGE_CONFIG`：服务端 YAML 配置路径，传给服务进程。也可使用配置中显式的 `--config` 参数；服务端的 `--config` 优先于环境变量。

上述环境变量的相对路径相对于 Pi 工作目录。JSON 中 `args` 的路径相对于配置的 `cwd`，推荐使用绝对路径。

继承 MCP SDK 默认环境（HOME/PATH 等）及 XDG 目录、TMPDIR、SSH_AUTH_SOCK、Docker 连接变量。其他凭据应通过 `env` 或服务端 harness 配置显式提供。不要把凭据提交到仓库。未知字段和无效配置会直接报错，不静默忽略。

## 工具

连接后从服务端 `tools/list` 动态读取参数 schema 和能力，注册为 `acp_<服务端工具名>`。当前服务端包含：

`acp_ping`、`acp_harness_info`、`acp_create_session`、`acp_authenticate`、`acp_auth_info`、`acp_set_model`、`acp_send_message`、`acp_message_result`、`acp_answer_question`、`acp_cancel_message`、`acp_live_output`、`acp_close_session`。

其中 **`acp_send_message` 与服务端原始语义不同：提交后同步等待并返回最终结果，而不是立即返回 message_id。** 参数仍与服务端一致，包括 `mode` 和 `idempotency_key`。

额外提供 **`acp_wait`**：只等待已知的 `session_id/message_id`，不重新提交消息。正常的 `acp_send_message` 已经同步等待，不需要再调用它。

需要 `acp_wait` 的情况：

- MCP 连接中断或 Pi 重载后，已知原消息 id，恢复对该消息的等待，避免重复提交。
- 无 UI 模式返回 `waiting_input`，调用 `acp_answer_question` 后继续等待原消息。
- 弹窗结果解析或校验失败，手动处理待回答请求后恢复等待；如果交互条件已修复，也可以用它重新弹窗。

如果之前明确中止等待工具，扩展会取消远端消息；`acp_wait` 不能复活已取消的消息，只能读取其终态。发送入口只有 `acp_send_message`，不提供重复别名或 `wait=false`。

推荐调用顺序：

```jsonc
// 发现模型和权限模式
acp_harness_info {}

// 创建会话：所有 SSH / Docker / resume / thinking_level 等参数均由服务端定义
acp_create_session {
  "harness": "codebuddy",
  "cwd": "/absolute/path/to/repo",
  "model_id": "claude-sonnet-4",
  "permission_mode": "auto"
}
// → session_id

// 保持这次工具调用；权限或信息请求在其中弹窗
acp_send_message {
  "session_id": "<session_id>",
  "text": "分析这个仓库",
  "idempotency_key": "analysis-1"
}
// → terminal: true、state、text、tool_calls 等服务端结果

// 不再使用时显式关闭远端会话
acp_close_session { "session_id": "<session_id>" }
```

服务端仍只接受每会话一个非终态消息，`busy` 等错误原样报告，不在客户端擅自排队、steer 或重试。网络中断后提交可能已生效；用同一 `idempotency_key` 重试可避免重复消息。

## 反向交互

1. 在原工具执行上下文中检查 `ctx.tools`，有可调用的 `ask_user` 时通过 `ctx.executeTool()` 调用。
2. 没有可调用的 `ask_user`，或其问卷容量不足时，使用 Pi 原生 `ctx.ui.select/input`。TUI 中显示对话框，RPC 中通过 Extension UI 协议交互。
3. 权限选项按索引保留与 `optionId` 的对应关系，将用户明确选择转为 `response: { option_id }`；拒绝选项也是原样选择，不推测、不默许。
4. 信息 / form elicitation 的对象字段生成输入或选择题，数字 / 布尔 / JSON 还原类型，并通过 JSON Schema 校验。无法拆分的表单要求用户输入完整 JSON 对象；默认值仅作提示，不静默提交。
5. 弹窗中仍持续检查服务端状态；远端结束或请求过期会关闭旧弹窗，提交答案前再次确认 request_id，防止迟到答案。多个会话的弹窗串行展示。

`ask_user` 采用 [pi-ask-user](https://github.com/black-94/pi-ask-user) 的结构化结果契约（`details` / `structuredContent` 中的 status、answers；answers 中的 selections/freeText）。人类可读文本不会被推测成答案。对 ask_user 的取消 / 超时不会二次提问；配置错误或实际 UI 失败也不会绕过其配置。只有 UI 尚未启动的 unavailable/not_initialized 可回退。该工具自己的用户配置可能覆盖请求超时。

交互发生时仅暂停远端等待用户决定，**Pi 的父工具仍保持执行**。弹窗回答后恢复同一消息，不会打断成两个工具调用。

### 无 UI 与取消

- print/JSON 等无 UI 模式遇到反向请求时，返回 `waiting_input` 及交互对象，不批准也不伪造答案。调用 `acp_answer_question` 后再 `acp_wait`。
- 用户关闭弹窗 → `answer: cancel`；到期 → `answer: timeout`。服务端决定继续还是取消该消息。
- 中止 Pi 的等待工具 → 调用服务端 `cancel_message`，取消当前远端消息。
- UI 结果无法解析或校验失败 → 报错，保持请求待回答；可手动回答或再次 `acp_wait`。
- 扩展 shutdown/reload 会停止本地轮询、关闭弹窗与 MCP 连接，**不会隐式关闭服务端会话**。在当前 Pi 分支保存了未完成 message_id 的情况下，重载后恢复监控；没有正在运行的工具上下文时恢复监控使用原生 UI。

## 输出

等待期间通过 Pi 工具更新展示滚动预览（最近 16 KiB 字符），最终结果来自终态 `message_result`，不把预览当最终答案。`failed` 终态作为工具错误返回。超过 20,000 字符的模型输出保存到权限为 0600 的临时 JSON 文件，工具文本附文件路径；结构化结果保留完整数据。MCP stdio 单帧仍受 SDK 默认 10 MiB 限制。

## 开发与验证

```bash
npm run dev:setup         # 干净安装 + Pi 开发依赖安全修补
npm run check              # 类型检查 + 默认测试
npm audit --omit=dev       # 运行依赖安全检查
npm pack --dry-run
pi -e ./index.ts           # 从源码临时加载
```

Pi `1.0.0` 自带 shrinkwrap，将开发依赖 `brace-expansion` 锁在有漏洞的 `5.0.9`，npm override / audit fix 无法覆盖。`npm run dev:setup` 在 `npm ci --ignore-scripts` 后执行 `fix:dev-deps`：从 npm 获取并校验 `5.0.12` 的固定 integrity，仅替换该开发依赖并同步 lockfile。修补脚本不进入发布包、不修改全局 Pi，也不在用户安装扩展时运行；上游修复后可移除。单独运行 `npm ci` 会恢复上游旧版本，之后须运行 `npm run fix:dev-deps` 再做审计。

本扩展以 TypeScript 源码发布，由 Pi 加载，无需生成 dist。`pi-package` 用于 Pi 扩展目录发现，`pi-extension` 标识扩展类型；Pi 提供的包仅声明为 peerDependencies。

包含交互路由、类型还原、权限映射、去重、超时 / 取消、无 UI、配置和真实 MCP stdio 扩展集成测试。

对真实服务端追加端到端测试（使用服务端仓库的 mock ACP harness，不调用真实模型，也不启动 Docker/SSH）：

```bash
ACP_BRIDGE_SERVER_DIR=/absolute/path/to/harness-acp-bridge-server npm run check
# 使用独立临时 daemon/socket/state，测试后关闭
```

## 发布检查

1. 确认依赖的 `@black942026/harness-acp-bridge-server` 版本已发布且 npm 可查询；`0.1.0` 已纳入 lockfile，使用 registry 包而非本地链接。
2. 更新依赖时执行 `npm install --package-lock-only --ignore-scripts`，再 `npm run dev:setup`、`npm run check` 和真实服务端端到端测试。
3. 执行 `npm audit --omit=dev`、`npm audit`、`npm pack --dry-run`，确认发布包仅包含源码、文档、示例与 LICENSE，无凭据或本机配置。审计必须在开发依赖修补之后运行。
4. 核对版本、提交源码 / 测试 / 维护脚本 / lockfile，执行 `npm publish --access public`（`prepublishOnly` 自动验证开发依赖修补并运行检查）。需要 npm 登录、scope 发布权限及账号要求的 2FA。
5. 在隔离的 Pi 配置目录中执行 `pi install npm:@black942026/harness-acp-bridge-pi-extension`，确认无需全局服务端即可连接并处理反向交互。

## License

MIT
