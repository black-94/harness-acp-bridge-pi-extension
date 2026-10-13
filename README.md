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
  ├─ 轮询 message_status（含可选的有界 progress 快照 → UI-only 预览）
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

**配置优先级：环境变量 > JSON 配置 > 内置默认值**（与 MCP 代理一致）。两端共用
`HARNESS_ACP_BRIDGE_URL` / `_AUTOSTART` / `_SERVER_ENTRY` / `_CONFIG` / `_STARTUP_TIMEOUT_MS` /
`_TIMEOUT_MS`；各自保留自己的默认超时值，Pi 仍保留上面的全局/项目/显式 JSON 选址规则。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8787` | 服务端地址；仅 `http`/`https`，不含凭据、查询串或片段 |
| `requestTimeoutMs` | `900000` | 单次 HTTP 请求超时，需覆盖创建 / 认证的耗时 |
| `interactionTimeoutMs` | `60000` | 每个交互问题的超时（Pi 专属，无共用环境变量） |
| `pollIntervalMs` | `500` | 状态 / 输出轮询间隔（Pi 专属，无共用环境变量） |
| `autoStart` | `true` | 服务不可达时是否按需启动本地服务 |
| `serverEntry` | — | 显式指定启动本地服务时加载的 **server 模块**（或路径 / `file:` URL）。相对路径按 `ctx.cwd` 解析；必须导出 `HarnessHttpServer`/`loadConfig` 的 server 入口（包 `index`），**不是** `hacpd`（`dist/main.js`）这类 CLI。一旦设置即为最终选择：绝不静默忽略，也不回退探测 PATH/依赖 |
| `configPath` | 环境变量 / 默认 | 传给所启动服务的 YAML 配置路径 |
| `startupTimeoutMs` | `30000` | 等待所启动服务响应 `ping` 的上限 |
| `askUser` | 见下文 | 可选交互工具的名称、来源白名单和版本下限（Pi 专属 JSON） |

**共用的环境变量（env 覆盖 JSON 与默认值）：**

| 环境变量 | 覆盖字段 | 默认 |
| --- | --- | --- |
| `HARNESS_ACP_BRIDGE_URL` | `baseUrl` | `http://127.0.0.1:8787` |
| `HARNESS_ACP_BRIDGE_AUTOSTART` | `autoStart` | `true` |
| `HARNESS_ACP_BRIDGE_SERVER_ENTRY` | `serverEntry` | — |
| `HARNESS_ACP_BRIDGE_CONFIG` | `configPath` | 环境变量 / 默认 |
| `HARNESS_ACP_BRIDGE_TIMEOUT_MS` | `requestTimeoutMs` | `900000` |
| `HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS` | `startupTimeoutMs` | `30000` |

> **超时对应键**：MCP 的 `timeoutMs`（env `HARNESS_ACP_BRIDGE_TIMEOUT_MS`）对应 Pi 的
> `requestTimeoutMs`（同一个 env）；`startupTimeoutMs`（env `HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS`）
> 两端同名同 env。Pi 的 `interactionTimeoutMs`/`pollIntervalMs` 为 Pi 专属 JSON，暂无共用 env。

**不接受 `command`/`args`/`env`/`cwd` 等启动透传字段**：扩展只连接服务，不注入命令或环境。
未知字段直接报错，不静默忽略。`HARNESS_ACP_BRIDGE_CONFIG` 仍被沿用为服务端配置路径（且 env 优先于 JSON）。

### 本地服务入口选择

需要本地启动服务时，入口按以下顺序确定：

1. `HARNESS_ACP_BRIDGE_SERVER_ENTRY` / JSON `serverEntry`——可导入的 server **模块**，显式且最终；
   值错误则 `startup_failed`，绝不静默跳过。
2. `PATH` 上的 `hacpd`（固定名探测，绝非调用方提供的命令）。标准 npm 全局安装是 `.bin` 指向包内
   `dist/main.js` 的 symlink；扩展会解析该 symlink，并因 CLI 在同一进程内启动服务且**不读取 stdin**，
   用 `node --import <内置 watchdog> <hacpd>` 启动，使得子进程 PID 就是应答 `ping` 的服务 PID
   （精确所有权证明），且 supervisor 退出（含 `SIGKILL`）会以 stdin EOF 传递到服务并停止它而不是
   遗留孤儿；真实脚本自身的模块解析保持不变。
3. 否则使用已安装依赖 `@black942026/harness-acp-bridge-server` 的模块入口。

**不是 Node 脚本**的 `hacpd`（其它 shebang，如 shell wrapper）无法携带进程内 watchdog 或给出精确
PID，因此明确 `startup_failed`（日志中会说明支持布局）而绝不冒险运行。找到 `hacpd` 但启动后始终不
应答 `ping`、或应答不兼容，同样硬失败——**启动失败后绝不切换到下一个入口**。`PATH` 中的空分量表示
cwd，相对分量按客户端启动时的 cwd（而非 supervisor 的 cwd）解析；**未设置 `PATH` 时完全不探测
`hacpd`**（绝不会把未设置当作 cwd），因此项目内的 `hacpd` 不会被误运行。

> **迁移**：旧版本用 `command`/`args`/`env` 指定如何 `spawn` 服务端 CLI。这些字段已移除且会被
> 拒绝；请改为配置 `baseUrl`（并按需 `autoStart`/`serverEntry`/`configPath`）。旧的 socket
> server 与本扩展不再兼容。

## 本地服务生命周期

1. `ping` 配置的 `baseUrl`；返回 `protocol_version: 4` 的服务被直接复用。旧协议（例如仍在运行的
   `protocol_version: 3` daemon，其 `create_session` 仍引用模板）一律视为不兼容并**拒绝**，但**绝不重启、替换或终止**它。
2. 若地址被占据但**不是**兼容的 bridge 服务（错误信封、协议版本不符、或非 JSON 监听者），
   扩展报 `incompatible_server` 并且**不**另起服务——外来服务不会被当作“不存在”。
3. 若无人监听、`autoStart` 为真，且地址是 **loopback**，扩展才启动服务。非 loopback 地址绝不
   本地 spawn，也不经 SSH 启动。
4. 启动由客户端目录下按地址加锁串行化，随后重新探测，两个客户端并发启动同一实例会收敛到一个
   服务（服务端自身的 `state_dir` 锁与端口绑定是最终兜底）。
5. 所启动服务作为**分离式日志 supervisor** 的子进程运行：supervisor 把服务的真实 stdout/stderr
   fd 接成 **pipe**（而非日志文件），两路独立、跨 chunk 有界地脱敏后再 append 到日志。因此它独立
   于客户端存活，且**客户端永不主动 kill 它**，不会误伤其他客户端会话或复用实例。
   `<client dir>/servers.json`（默认 `~/.harness-acp-bridge-client`）记录真实 server pid、supervisor
   pid 与日志路径。所有权是**证明**而非猜测：客户端用新 nonce 启动 supervisor，仅当应答 ping 的
   pid 等于 supervisor 记录的 `server_pid`、且私有 proof 文件携带该 nonce 时才 claim；抢赢的
   peer 被复用，外来监听者绝不被当作“无人监听”、也绝不被 kill。
6. `shutdown`/`reload` 只释放客户端自身的连接，**不关闭已有服务端会话，也不停止复用实例**。

## 工具

注册 10 个 `acp_` 工具（与服务端同名）加两个模板工具、`acp_wait`：`acp_ping`、
`acp_search_template`、`acp_create_template`、`acp_create_session`、
`acp_close_session`、`acp_authenticate`、`acp_auth_status`、`acp_set_session_options`、
`acp_send_message`、`acp_cancel_message`、`acp_message_status`、`acp_answer_question`，
外加上面的 `acp_wait`。

- **`acp_send_message`**：提交后在同一调用内同步等待终态（与 `acp_wait` 相同语义）。
- **`acp_wait`**：只等待已知的 `session_id`/`message_id`，不重复提交；用于 MCP/重载后恢复、无 UI
  场景回答后继续等待。
- **`acp_authenticate`**：驱动服务端托管的认证流程（见下）；`acp_auth_status` 轮询同一流程状态，
  无流程时退回认证探测语义。
- 没有单独的增量输出接口（`live_output` 已移除）。运行中的预览只来自 `message_status` 的可选有界
  `progress` 快照（`{text, reasoning, tool_calls}`），仅供 UI；终态以 `result` 为准。

推荐顺序：`acp_create_session` → `acp_send_message`（内部同步等待并弹窗）→ 结束；不再使用时
`acp_close_session`。需要登录时 `create_session` 会返回结构化的 `authentication_required` 错误
（`detail.session_id` + `detail.next_action`），由模型调用 `acp_authenticate`；扩展**不会**自动认证。
服务端仍只接受每会话一个非终态消息，`busy` 等错误原样报告；客户端不排队、不 steer、不重试。网络中断后
提交可能已生效，用同一 `idempotency_key` 重试可避免重复。

### 启动模板

`search_harness` 接口和 `acp_search_harness` 工具已移除，请使用模板或显式会话参数选择 harness。
模板只是**信息**，由服务端持久存储；`acp_create_session` **不再**接受模板引用。本扩展只暴露两个工具：

- **`acp_search_template`**：按精确 `name`、`query`（name/harness/description 的大小写不敏感子串）
  和/或 `harness` 查找模板，返回**完整内容**供模型自行展开。不启动 harness。
- **`acp_create_template`**：`{template: {...}}` 持久注册一个模板，是服务端 `register_template`
  的**客户端别名**（不会 `POST /api/create_template`，也不暴露删除）。**不创建会话、不启动 harness**；
  重名返回 `template_exists`，绝不覆盖。注册前请按 `acp-create-template` skill 收集信息并与用户确认。

模板新增五个可选字段（默认 `null`）：

- `model`：默认模型 ID，展开为会话 `model_id`。
- `thinking`：默认思维强度，展开为会话 `thinking_level`；不写死候选值，交由实际 ACP 校验。
- `before_start`：ACP 启动前动作的自然语言提示。
- `after_start`：ACP 成功启动并完成必要认证后的动作提示。
- `special_instructions`：整个工作流应遵循的特殊提示。

后三个字段由**调用方 LLM 用自己的工具执行**，不是服务端/扩展自动执行的脚本 hook；创建和搜索模板不会执行它们。
需要审批的操作仍要用户确认；动作失败或工具不可用时报告阻塞，不得假装已执行。

推荐工作流：精确搜索模板并读完整内容 → 将非 null `model`/`thinking` 映射到会话参数（用户覆盖优先），
仅询问缺失的模型或 `cwd` → 遵循特殊提示并执行启动前动作 → 用**显式允许字段**创建会话 → 完成必要认证 →
执行启动后动作 → 发送正常工作。Docker 的 `network_mode` 映射为会话 `host_network`（host 为 true，
none/proxy 为 false），透传返回的完整 env。**丢弃** `name`/`description`/`model`/`thinking`/`network_mode`/
`proxy_port`/`before_start`/`after_start`/
`special_instructions` 和不适用字段；绝不向 `create_session` 传模板引用或模板专用字段。
对会话非法的 null 要省略（例如 local `remote_host`、缺失的 `cwd`），覆盖 runtime/target 后重新检查组合。
客户端不实现第二套模板默认值合并。

**配置迁移**：从服务端 YAML 删除整个旧 `harnesses` 段（含模型/思维强度候选与描述）。
`codebuddy`、`codex`、`agy` 内置 adapter 无需声明即可使用，由模板或显式会话参数选择；未传 harness 时
使用 `default_harness`（默认 Codex）。所有服务设置使用默认值时无需 YAML 文件。
模型/思维强度默认值放在模板或显式会话参数中，已有模板缺失五个新字段时自动补 null。

### Docker 网络三选一

模板改用 `network_mode: none | host | proxy`，不兼容旧模板 `host_network` 字段：

- `none`（默认）：普通 Docker 桥接网络，不配置代理。
- `host`：宿主机网络，不配置代理或发布端口。
- `proxy`：普通桥接网络，只填 `proxy_port`（1–65535），代理实现不限 Xray。

proxy 模式由服务端在注册时生成：

```text
http_proxy  = http://host.docker.internal:PORT
https_proxy = http://host.docker.internal:PORT
no_proxy    = localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local,.internal
```

自动替换旧的大小写代理变量，保留其他 env。不再分别询问 HTTP/HTTPS 地址或绕过列表。
启动时 LLM 将返回的 env 透传给会话，`network_mode`/`proxy_port` 不是会话参数。
宿主机地址需从执行目标的容器内验证；Linux 可能需要 host-gateway 配置，不自动修改网络或代理服务。
HTTP 客户端需要支持这些环境变量及 CIDR 绕过规则，env 成功透传不等于代理已连通。
旧模板需重新注册，无自动兼容迁移。

### acp-create-template skill

`acp_create_template` 的配套指导以**可移植**的 Agent Skills 目录发布：
[`skills/acp-create-template/SKILL.md`](skills/acp-create-template/SKILL.md)（通过
`package.json` 的 `pi.skills` 声明，随 npm 包打包）。它指导模型**条件式**收集 `name`/`harness`、
运行位置（local/remote/remote_host）、direct/Docker、`permission_mode`，可选的 `cwd`/`command`/`args`/
`env`，可选的 `model`/`thinking` 默认值与三个自然语言提示，以及 Docker 的
image/login_dirs/mounts/ports/network/container_policy；不询问不适用的参数，不索取
密码/token/secret，明确持久化 `env` 的风险，重名不静默覆盖，创建前展示摘要取得确认，取消/超时/UI 不可用
时不编造答案；并说明模板 `model`/`thinking` 要映射为会话字段，创建模板不会启动会话或执行动作提示。
MCP 宿主可按 Agent Skills 规范直接加载
同一目录（`SKILL.md` 是纯 Markdown，无需 Pi 运行时），对应的可执行工具是 bare `create_template`。

## 认证

`acp_authenticate` 只接收 `{session_id}`，由**工具自身**完成交互，绝不由调用方传入 `method_id`：

1. 服务端立即返回流程快照 `{session_id, state, terminal, questions, candidates?, authenticated?, error?}`
   （`state` ∈ `waiting_input|authenticating|ready|failed|cancelled`；限流为
   `authentication_rate_limited` 且 `terminal:true`；已登录直接 `ready`）。
2. 方法选择是一条 `information` 问题（`schema` 要求 `method_id` 枚举受支持 ID）。扩展把候选
   （**包括** `type!=="agent"` 的不受支持项及其 `Not supported in harness_acp_bridge` 说明）完整展示给
   用户，由用户选择；**绝不自动选择**，即使审批模式为 `auto`。
3. 浏览器/设备码/令牌问题按服务端给出的 schema 原样收集：CodeBuddy 是“打开此 URL 后确认”
   （`opened:boolean`），确认**不等于**成功——扩展继续轮询直到真实 `ready/loginCompleted`；Agy 令牌、
   Codex 设备码等按 `string` 等 schema 连续多轮收集。扩展不打印、不持久化真实令牌。
4. 每轮回答都以**会话级** `answer_question`（不带 `message_id`）提交，回答前再次校验 `request_id`；
   弹窗期间并行轮询流程状态，流程终态或 `request_id` 变化会立即取消弹窗。
5. 无 UI 时返回 `waiting_input` 及完整 `questions`，不虚构答案；用户 `answer_question` 后再
   `acp_authenticate` 继续。中止 `acp_authenticate` **仅**退出本地等待，不取消远端消息，也不发答案；
   用户取消/超时则作为真实答案提交。

## 反向交互

1. 在原工具执行上下文中，配置的交互工具可调用且通过工具名、Pi 来源元数据、实际安装包名称和
   最低版本校验后，才经 `ctx.executeTool()` 调用。校验不符时**不调用、不直接报错**，提示原因后
   降级到 Pi 原生 `ctx.ui.select/input`（TUI 弹窗；RPC 经 Extension UI 协议）；无 UI 则保留 `waiting_input`。
2. 权限选项按索引精确映射回 `optionId`；拒绝选项原样选择，不推测、不默许。
3. 信息 / form elicitation 的对象字段生成输入或选择题，数字 / 布尔 / JSON 还原类型并做 JSON
   Schema 校验；无法拆分的表单要求输入完整 JSON 对象。默认值仅作提示，不静默提交。
4. 弹窗期间仍持续检查服务端状态；远端结束或请求过期会关闭旧弹窗，提交答案前再次核对
   `request_id`，防止迟到答案。多会话弹窗串行。
5. `ask_user` 采用 [pi-ask-user](https://github.com/black-94/pi-ask-user) 的结构化结果契约；
   人类可读文本不会被当作答案。取消 / 超时不会二次提问；只有 UI 尚未启动的
   unavailable/not_initialized 可回退到原生 UI。

字段类型严格按 schema 与 pi-ask-user 契约映射，受限选择一律 `allowFreeText: false`：

| schema 属性 | `ask_user` 字段 | 还原 |
| --- | --- | --- |
| 无枚举 `boolean` | `bool` | 真布尔值，`false` 不被丢弃 |
| `enum` / `const`（含布尔枚举） | `single` | 按标签映射回原始类型值，限制不被放宽 |
| `array` + `items.enum` / `items.const` | `multi` | typed 数组；schema 要求的数组可回退为空 `[]` |
| `string` / `number` / `integer` / 自由 `array` | `input` | 数字 / JSON 还原后再做 Ajv 校验 |

可安全表达的平面对象聚合成**单个** `simple-form`（1..10 字段）：`name` 为安全字面键，`label`
（schema `title`，不含 `description`）与选项标签 ≤ 80 字符，可选字段留空即省略，`required` 空值被拒。
`schema.description` 不截断：选项字段经选项 `preview`（≤ 4000）完整承载，bool/input 字段经 `prompt`
（≤ 500）承载；承载不下则退回原生 UI，绝不截断用户决策所需的说明 / URL。

降级为**整对象 JSON `input`** 的情形：嵌套 / 组合 schema、> 10 字段、不合法字段名。该 `input` 的
`prompt`（≤ 500）会列出期望字段与原始 schema，承载不下则退回原生 UI。另有两条独立降级：某字段
选项 **> 5**（超出 `ask_user` 选项上限）直接退回原生 UI（仍为 form 逐字段，而非整对象 JSON）；唯一
上下文放不进 prompt 且无 `preview` 承载时同样退回原生 UI。原生回退中，bool/single 的可选字段提供
明确的跳过项，multi 会把全部编号候选（原始值，不截断）显示在输入框标题里。schema `default` 仅作
原生占位提示，绝不自动提交。

### 交互工具来源与版本校验

本扩展不自动安装或加载 `pi-ask-user`；未加载时照常使用原生 UI。可选安装：

```sh
pi install npm:@black942026/pi-ask-user
```

默认策略（写在 `harness-acp-bridge.json`，没有独立环境变量）：

```json
{
  "askUser": {
    "toolName": "ask_user",
    "sources": ["npm:@black942026/pi-ask-user"],
    "minVersion": "0.1.4",
    "minVersionExclusive": false
  }
}
```

- `toolName` 精确匹配，绝不寻找名称相似的工具。
- `sources` 是来源白名单，不是工具描述或返回结果的自报信息。每次调用前重新查询
  `pi.getAllTools().sourceInfo`；缺失、不明确或不可读取时拒绝使用可选工具。
- 默认只允许指定 npm **包名**；无版本的 npm 白名单项也接受该准确包名的版本/range/tag 来源。
  不接受包名前缀碰撞、npm alias、其他包或任意本地同名文件。指定了 npm 版本/range 时，实际
  安装版本还必须匹配 Pi 记录的 selector。
- 从真实扩展路径读取最近的 `package.json`，核对 `name === "@black942026/pi-ask-user"` 与实际
  `version`，而不是拿来源字符串中的版本当作已安装版本。入口及 manifest 的 realpath 不得
  逃出 Pi 记录的来源目录；无法读取 manifest 时同样降级。
- `minVersion` 是完整 SemVer 下限，默认 **`>=0.1.4`**，更高稳定版本无需逐个加入列表。
  `minVersionExclusive: true` 改为严格 `>`。按 SemVer 比较，不按字符串字典序；稳定下限默认
  不接受预发布版本。这里是包版本校验，不代表未来版本的接口永远兼容，结果仍需结构化校验。
- Git 来源需要把 Pi 记录的完整来源（包括 ref）显式加入 `sources`；本地开发可加入
  `"path:/absolute/path/to/pi-ask-user/index.ts"`，只允许这个真实入口文件，且仍核对包名和版本。
  `sources: []` 禁用可选工具，始终使用原生 UI。这里不支持通配符。
- 项目配置按 `askUser` 的子字段覆盖全局配置；`sources` 数组整体替换，不自动追加。
  无匹配/来源不明/版本不符只会在调用前告警并使用原生 UI；无 UI 保留问题供手动回答。

这是宿主提供的**加载来源校验**，不是发布者签名或对恶意扩展的进程隔离。所有已加载扩展
共享 Pi 进程权限，来源白名单不能替代安装前审查。已经调用工具后的取消、超时或未知返回
不会再次弹窗；只有 UI 尚未启动的 `unsupported_mode`/`not_initialized` 才可回退。

### 无 UI、取消与输出

- print/JSON 等无 UI 模式遇到反向请求时返回 `waiting_input` 及原始 `questions`，不批准也不伪造。
  调用 `acp_answer_question` 后再 `acp_wait`。
- 关闭弹窗 → `answer: cancel`；到期 → `answer: timeout`；服务端决定继续还是取消消息。
- 中止 `acp_wait`（工具取消 / `signal`）仅退出本地等待，不取消远端消息；可用同一
  `session_id`/`message_id` 再次 `acp_wait`。中止 `acp_send_message` 仍调用 `cancel_message`
  取消远端消息。服务端超时、问答结果、JSONL 错误的原有处理不变。
- **预览与活动仅用于 UI**：等待期间通过工具更新的 `content: [{ type: "text", text: "" }]`、
  `structuredContent: {}`、`details.preview` 传递预览与服务器活动指标（`details.activity`：
  `observed_phase`、`seconds_since_progress`、`stalled` 等），由 `acp_send_message`/`acp_wait` 的自定义
  `renderResult` 渲染（Pi 默认不展示 `details`）。预览**派生**自 `message_status.progress` 的有界快照
  （每轮替换，不追加），终态以 `result` 刷新。运行中表头显示最后观测阶段与「距上次进展 X 秒 /
  疑似停滞」；`running` 仅表示「仍在等待 ACP 结果」，**不保证模型仍在推进**。预览与活动**不进入**
  模型上下文，也**不**出现在 `send_message`/`wait` 最终返回的 `content`、`structuredContent` 或可
  持久化数据里。最终答案来自 `message_status.result`；没有单独的增量输出接口。
- 需要登录时，`create_session`/`send_message` 返回结构化的 `authentication_required` 工具错误
  （模型可读的 `content`/`structuredContent` 保留 `code`、`detail.session_id`、`detail.next_action`），
  提示模型调用 `acp_authenticate`；扩展不会自动认证。
- `failed` 终态作为工具错误返回。超过 20,000 字符的结果写入权限 0600 的临时 JSON 文件，工具文本
  附路径，结构化结果保留完整数据。
- shutdown/reload 停止本地轮询、关闭弹窗，不隐式关闭服务端会话、不停止复用服务；分支内已保存的
  未完成 `message_id` 会在重载后恢复监控。

## 隐私

扩展对真实 HTTP 响应照常返回，**只脱敏它自己写到磁盘的副本**，且只处理常见凭据形态。

- 分离式 bootstrap 是**日志 supervisor**：它以 stdout/stderr 为 **pipe**（绝非日志文件）启动真正的
  服务，并把两路独立、跨 chunk 有界地脱敏后 append 到 `server-<addr>.log`。因为真实 fd 是 pipe，
  所有输出路径都被覆盖：`console`、`stream.write`、**`fs.writeSync(1/2)`**、`fs.writev`、原生模块、
  动态 import 与运行时诊断。JS 层 patch `write` 看不到 fd 级写入，pipe 边界可以。
- 脱敏完全在分离式 supervisor 内，不在客户端，因此客户端退出后仍持续工作；EOF 时两路滞留尾部先
  脱敏 flush 再关日志 fd；日志只 append，绝不改写已有字节。
- 脱敏或磁盘错误绝不回退为明文：脱敏异常丢弃该 chunk，磁盘写入失败则停止自有服务并以非零退出，
  既不无限重试，也不让服务端因 pipe 满而永久阻塞。
- `logTail` 与 registry 的读时遮盖只是纵深防御，不是安全边界。
- `servers.json` 在原子写入前先脱敏；顶层 map key 是 baseUrl（本身已校验无凭据）并原样保留，
  保证 registry 与所有权探测可用。日志文件为 0600、位于 0700 客户端目录，launcher proof 文件 0600。
- 规则来自 server 的规范源文件：`src/redact-core.mjs` / `src/redact.mjs` 由
  `server/src/redact/redact-core.ts`（sha256 `b07ef16e39483b008c0f03e3da05dc194c87fa93080b53accf34317586d2a6c8`）
  与 `server/src/redact/redact.ts`
  经 `tsc` 转译得到，**唯一改动是把内部 `./redact-core.js` import 改成 `.mjs`**；`redact-core.d.mts` /
  `redact.d.mts` 同为生成的声明。无运行时跨仓库 import，普通 Node（>=20.11）直接运行、无需 TS loader。
  重新同步：对 server 的两个 TS 跑 `tsc --outDir <tmp> --target ES2022 --module ES2022
  --moduleResolution node --declaration`，把 `redact-core.js`/`redact.js` 的 `.js` 改为 `.mjs` 后拷入 `src/`。
- parity harness（`npm run parity`）加载本包与同级 server 构建，对非流式与流式 API 做逐字节一致性校验
  （报告：`/tmp/redaction-parity-pi.log`）。MCP 客户端以同一份 server 构建做同样的校验，因此三端传递一致。
- 只识别常见敏感字段/正文凭据：未知/未识别文本（含 `max_tokens` 这类计数、普通中文/emoji）
  原样保留；不保证清除所有未知秘密。
- 超大 toolResult（>20000 字符）落盘前递归脱敏：临时目录 700、结果文件 600；内存中返回给模型
  的业务语义不变，preview 仍只存在于 `details.preview`。

## 开发与验证

```bash
npm run dev:setup         # 干净安装 + Pi 开发依赖安全修补
npm run check             # 类型检查 + 测试（含真实 server + mock harness 端到端）
npm run test:protocol     # 可选：用相邻 ../pi-ask-user 的真实 normalizer 交叉校验 ask_user 参数
npm audit --omit=dev
npm pack --dry-run
```

默认 `npm test` 完全自包含（不依赖相邻 `../pi-ask-user` 检出）：反向交互参数用
`test/ask-user-contract.ts`（pi-ask-user `AskUserParams` 的严格镜像）校验。若需用真实 normalizer
复核，额外检出 `../pi-ask-user` 后运行 `npm run test:protocol`（属 `test/protocol/`，不进入默认
`npm test`）。

`npm run check` 会按需启动**真实 HTTP server**与 server 仓库的 mock ACP harness（不调用真实模型、不用
Docker/SSH），驱动创建会话 / 提交 / 同步等待 / 结果 / 权限弹窗 / 认证流程（未登录 `create_session` →
方法选择 → URL/令牌回答 → `auth_status` 成功）/ 取消 / 无 UI / shutdown 不杀复用实例，以及模板流程
（`acp_create_template` → `acp_search_template` 按 name/query/harness 查找 → 把允许字段展开为**显式**
`acp_create_session`（继承 cwd 再覆盖、command/args/env 真实运行）→ `template` 引用 / 重名 / 未知 / 非法模板
/ 缺 cwd / 启动内部字段被拒）等链路。harness 命令现在来自显式 `command`/`args`/`env` 或执行目标 `PATH`，
无模板用例仍为 fake harness 安装 PATH wrapper。
集成与生命周期测试优先加载**仓库内 server 构建**（`../server/dist`，`serverEntry` 指向其模块入口），仅在
父检出缺失时回退到已安装包；因为客户端要求 `protocol_version: 4`，这些用例在 server 以新契约重建前
会**跳过**（不会对旧的已安装 server 假绿）。用 `ACP_BRIDGE_SERVER_DIR` 指向 server 检出（默认
`../server`）。

本扩展以 TypeScript 源码发布，由 Pi 加载，无需 `dist`；`skills/` 目录（`acp-create-template`）随包发布，
由 `pi.skills` 声明以供发现。`pi-package` 用于扩展目录发现，`pi-extension` 标识扩展类型；Pi 提供的包仅
声明为 peerDependencies。

Pi `1.0.0` 自带 shrinkwrap，将开发依赖 `brace-expansion` 锁在有漏洞的 `5.0.9`；`npm run
dev:setup` 在 `npm ci --ignore-scripts` 后运行 `fix:dev-deps` 修补该开发依赖（不进入发布包、不
改全局 Pi、不在用户安装时运行）。

## License

MIT
