# 钉钉插件多 Agent 设计 v2 — 对齐框架能力

> 日期：2026-03-16
> 目标：基于对 Discord / Telegram / Slack 等 channel 插件的调研，重新设计钉钉的多 Agent 能力，最大化复用 OpenClaw 框架机制，减少插件层自定义逻辑。

---

## 一、设计原则

1. **框架能力优先**：能用 adapter / hook / binding 解决的，不在插件层自建
2. **与其他 channel 对齐**：Discord 怎么做的，DingTalk 尽量用同样的模式
3. **渐进式实现**：每一步都可独立合入，不依赖后续步骤

---

## 二、目标场景

```
用户 @dba 查询慢了
  → 插件路由到 dba agent（独立 session + 独立 workspace + SQL 工具）
  → dba 执行 EXPLAIN，发现索引缺失，判断需要network协助
  → dba 调用 sessions_send("network", "帮我查下连接池配置")
  → [hook] 插件转发到群: "[network] 连接池 max_connections=50 偏低..."
  → ping-pong 继续，agent 间交流对用户实时可见
  → dba 综合结论回复群里
```

关键要素：
- 每个 agent 有**独立的工具和 workspace**（DBA 能执行 SQL，network能 ping）
- Agent 可**自主判断**是否需要调用其他 agent 协作
- Agent 间交互过程**对用户实时可见**
- 用户可以通过 @mention **手动触发**某个 agent

---

## 三、框架能力盘点

### 3.1 Agent 独立工具和 Workspace — 框架天然支持，零插件代码

每个 agent 在 `agents.list` 中配置独立的能力，框架自动隔离：

| 配置字段 | 作用 | 隔离方式 |
|---------|------|---------|
| `agentDir` | 独立 AGENT.md / system prompt | 每个 agent 自己的人格和指令 |
| `workspace` | 独立工作目录 | 非默认 agent 自动隔离到 `~/.openclaw/workspace-{id}` |
| `tools` | 工具策略（allow/deny/profile） | 每个 agent 可以有不同工具集 |
| `skills` | 技能白名单 | 控制 agent 可用技能 |
| `model` | 模型选择 | 不同 agent 可以用不同模型 |

配置示例：

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "dba",
        "name": "DBA",
        "agentDir": "./agents/dba",         // AGENT.md: 你是DBA agent，擅长SQL优化...
        "workspace": "./ws/dba",             // 独立工作目录
        "tools": { "profile": "coding" },    // 有 exec 工具权限
        "subagents": {
          "allowAgents": ["network", "log-expert"]  // 可调用的其他 agent
        }
      },
      {
        "id": "network",
        "name": "network",
        "agentDir": "./agents/network",
        "workspace": "./ws/network",
        "tools": { "profile": "coding", "allow": ["exec"] }
      }
    ]
  }
}
```

**当 @mention 路由到 dba agent 时，它自动获得自己的 workspace、工具和 system prompt。不需要插件做任何事。**

### 3.2 Agent 间协作 — 两种框架机制

#### 方式 1：sessions_spawn（子 agent 模式）

agent 调用内置的 `sessions_spawn` 工具创建独立的子 agent：

```
dba 调用 sessions_spawn({ agentId: "network", task: "帮我查连接池" })
  → network agent 在独立 session 中运行
  → 自动获得 network 的 workspace + 工具
  → 结果通过 announcement 推回 dba 的 session
  → dba 看到结果，综合后回复用户
```

需要的配置：`subagents.allowAgents` + `agents.defaults.subagents.maxSpawnDepth >= 1`

**优势**：框架完全管理生命周期，插件不需要额外逻辑
**劣势**：中间过程用户不可见（结果只回到父 agent session）

#### 方式 2：sessions_send（A2A 消息模式）

agent 调用内置的 `sessions_send` 工具直接给其他 agent 发消息，支持多轮 ping-pong：

```
dba 调用 sessions_send({ agentId: "network", message: "帮我查连接池" })
  → network agent 收到消息并回复
  → 可多轮交换（最多 maxPingPongTurns 轮）
  → 每轮通过 agent_to_agent_turn hook 转发到群（PR #46660）
  → 最后 announce 步骤发送结论到群
```

需要的配置：
```jsonc
{
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": ["dba", "network", "log-expert"]
    },
    "sessions": { "visibility": "all" }
  },
  "session": {
    "agentToAgent": { "maxPingPongTurns": 5 }
  }
}
```

**优势**：ping-pong 每轮可通过 hook 转发到群，用户实时可见
**劣势**：需要 `agent_to_agent_turn` hook PR 合入（openclaw/openclaw#46660）

### 3.3 Groups Adapter — 群聊策略

框架提供 `ChannelGroupAdapter`，Discord 和 Telegram 都通过它实现 mention-gating 和工具策略：

```typescript
groups: {
  resolveRequireMention: (params: ChannelGroupContext) => boolean | undefined;
  resolveToolPolicy: (params: ChannelGroupContext) => GroupToolPolicyConfig | undefined;
}
```

**DingTalk 应该做的**：注册 adapter，实现按群控制 mention 要求和 `allowAgents`。

### 3.4 Mentions Adapter — @mention 清洗

框架提供 `ChannelMentionAdapter`，自动从发给 agent 的消息中清除 @标记：

```typescript
mentions: {
  stripPatterns: (params) => string[];  // Discord 注册: ["<@!?\\d+>"]
}
```

**DingTalk 应该做的**：注册钉钉的 @mention 模式，让框架自动清洗。

### 3.5 Threading Adapter — 会话线程

框架提供 `ChannelThreadingAdapter`：

```typescript
threading: {
  resolveReplyToMode: (params) => "off" | "first" | "all";
  buildToolContext: (params) => ChannelThreadingToolContext | undefined;
}
```

其中 `ChannelThreadingToolContext.skipCrossContextDecoration` 可以控制是否给消息加 `[from X]` 前缀。

### 3.6 Subagent Hooks — 子 agent 生命周期

Discord 完整实现了三个 hook：

| Hook | Discord 的做法 | DingTalk 应该做的 |
|------|---------------|-----------------|
| `subagent_spawning` | 创建 Discord thread 绑定 | 记录群 → subagent 映射 |
| `subagent_ended` | 清理 thread binding | 清理映射 |
| `subagent_delivery_target` | 路由结果回原始 thread | 路由结果回原始群 |

---

## 四、@mention 路由 — 当前实现（PR #317）

这是**钉钉独有的**插件层逻辑——Discord/Telegram 有原生 thread/topic 做 agent 隔离，钉钉没有，只能通过 @mention 文本匹配实现。

### 当前实现链路

```
消息入站
  ↓
extractMessageContent() — 提取 @mentions
  richText 模式: part.type === "at" → 精确的 atName + atUserId
  text 模式: regex /@([^\s@]+)/g（已加引用前缀过滤）
  ↓
resolveAtAgents() — 匹配 agent
  @mentions × agents.list → matchedAgents[]
  优先匹配 name，再匹配 id（大小写不敏感）
  区分真人（有 userId）和 agent（无 userId）
  ↓
processSubAgentMessage() — 路由
  递归调用 handleDingTalkMessage，传入 subAgentOptions:
    agentId: 目标 agent ID
    responsePrefix: "[AgentName] "
    matchedName: 匹配到的名字
  ↓
handleDingTalkMessage（sub-agent 模式）
  用 rt.channel.routing.buildAgentSessionKey 构造该 agent 的独立 session key
  消息前加 "[你被 @ 为"agent 名"]" 上下文提示
  进入标准处理链（dispatch reply, card 等全部复用）
```

### 涉及的文件

| 文件 | 职责 | 新增/改动 |
|------|------|---------|
| `src/agent-name-matcher.ts` | @mention → agentId 匹配 | 新增 148 行 |
| `src/message-utils.ts` | 提取 @mentions + 引用前缀过滤 | 改动 ~30 行 |
| `src/types.ts` | AtMention, AgentNameMatch, SubAgentOptions | 改动 ~40 行 |
| `src/inbound-handler.ts` | sub-agent 检测 + 路由 + processSubAgentMessage | 改动 ~80 行 |

### 为什么必须在插件层做

框架的 `resolveAgentRoute` 只支持静态匹配（channel + accountId + peer）。按消息内容（@mention 文本）动态路由是框架不覆盖的。Discord 和 Telegram 也在插件层做了类似的事（thread binding、topic routing）——只是它们利用了平台原生的 thread 概念，而钉钉需要 @mention 文本匹配。

---

## 五、端到端场景推演

### 场景：DBA 自主拉入network

**配置**：

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "dba", "name": "DBA",
        "agentDir": "./agents/dba",
        "workspace": "./ws/dba",
        "tools": { "profile": "coding" },
        "subagents": { "allowAgents": ["network"] }
      },
      {
        "id": "network", "name": "network",
        "agentDir": "./agents/network",
        "workspace": "./ws/network",
        "tools": { "profile": "coding" }
      }
    ]
  },
  "tools": {
    "agentToAgent": { "enabled": true, "allow": ["dba", "network"] },
    "sessions": { "visibility": "all" }
  },
  "bindings": [
    { "type": "route", "agentId": "dba",
      "match": { "channel": "dingtalk", "accountId": "bot-1" } }
  ]
}
```

**AGENT.md（dba）**：

```markdown
# 角色
你是 DBA agent，擅长数据库性能分析和 SQL 优化。

# 可调用的协作 agent
- network（network）：擅长网络和连接池问题

# 协作规则
- 当你发现问题涉及网络层面（如连接池、网络延迟），使用 sessions_send 联系network
- 在 sessions_send 的 message 中包含你的分析结果，让对方有上下文
```

**执行流程（路径 C — A2A 模式）**：

```
1. 用户在群里: @DBA 查询慢了，帮忙看看

2. 插件层（阶段 1）:
   extractMessageContent → atMentions: [{name: "DBA"}]
   resolveAtAgents → matchedAgents: [{agentId: "dba"}]
   processSubAgentMessage → 递归调用 handleDingTalkMessage
     → buildAgentSessionKey("dba", ...) → 独立 session
     → dispatchReply → dba agent 开始处理

3. 框架层（dba agent 运行）:
   dba 获得自己的 workspace (./ws/dba) + tools (coding profile)
   dba 的 AGENT.md 指导它的行为
   dba 调用 exec 工具执行 EXPLAIN → 发现全表扫描
   dba 判断需要network
   dba 调用 sessions_send({
     agentId: "network",
     message: "用户反映查询慢，我发现 orders 表全表扫描。请查一下连接池配置是否合理。"
   })

4. 框架层（A2A 交换）:
   network agent 在自己的 session + workspace 中运行
   network 查连接池 → 回复: "max_connections=50 偏低，建议调到 200"
   [agent_to_agent_turn hook] → 插件转发到群:
     "[network] max_connections=50 偏低，建议调到 200"

   ping-pong 继续（如果需要）:
   dba 回复: "同意，加完索引后一起调连接池"
   [hook] → 插件转发: "[DBA] 同意，加完索引后一起调连接池"

5. announce 步骤:
   dba 综合结论发送到群:
   "排查结果：1) orders 表缺 created_at 索引 2) 连接池 max_connections=50 偏低
    建议先加索引，再调连接池到 200。"
```

**插件在整个过程中只做了两件事**：
1. 阶段 1 的 @mention → agent 路由（~80 行插件代码）
2. `agent_to_agent_turn` hook handler 转发消息到群（~10 行插件代码）

其余全是框架能力。

### 场景：纯 @mention 模式（无 A2A，路径 A）

如果 A2A hook 尚未合入，用现有的 `feat/expert-discussion-context` 分支：

```
1. 用户: @DBA @network 帮忙一起排查
2. 插件顺序处理两个 agent:
   → dba agent 回复: "[DBA] 发现全表扫描..."
   → network agent 回复: "[network] 连接池偏低..."
     （通过 discussionLog 注入，network能看到 DBA 之前说了什么）
3. 如果 DBA 回复中 @network → 插件检测并触发下一轮
```

**差异**：路径 A 中 agent 不会自主发起跨 agent 通信——由用户或插件链式触发驱动。路径 C 中 agent 自主调用 `sessions_send` 发起协作。

---

## 六、与 Discord / Telegram 的架构对比

| 维度 | Discord | Telegram | DingTalk（目标） |
|------|---------|----------|-----------------|
| Agent 触发方式 | @bot mention → binding 路由 | topic → binding 路由 | **@mention → 插件层路由** |
| 平台原生线程 | ✅ Discord thread | ✅ Telegram topic | ❌ 无（@mention 替代） |
| Agent 独立 workspace | ✅ 框架自动 | ✅ 框架自动 | **✅ 框架自动** |
| Agent 独立工具 | ✅ per-agent tools config | ✅ | **✅ per-agent tools config** |
| Groups adapter | ✅ | ✅ | **✅ 阶段 2 实现** |
| Mentions adapter | ✅ | ✅ | **✅ 阶段 1 补齐** |
| Subagent hooks | ✅ 3 个 hook | ✅ | **✅ 阶段 3 实现** |
| Agent 自主 spawn | ✅ sessions_spawn | ✅ | **✅ 框架内置，配置即用** |
| Agent 间 A2A | ❌ 未使用 | ❌ 未使用 | **✅ 阶段 4b（PR #46660）** |
| 讨论过程可见 | ✅ 通过 thread | ✅ 通过 topic | **✅ 通过 A2A hook 转发** |

**关键差异**：Discord/Telegram 通过原生 thread/topic 让 subagent 的输出在独立线程中可见。钉钉没有 thread，需要通过 A2A hook 把agent 间对话转发到群。这是 DingTalk 的 `agent_to_agent_turn` hook（PR #46660）存在的原因——**它解决的是钉钉缺少原生 thread 概念的问题**。

---

## 七、钉钉平台限制：无 Thread/Topic API

钉钉客户端有"群话题"功能（对某条消息的回复链），但这只是客户端 UI 层面的展示，**没有任何 API 暴露**：

| 能力 | Discord | Telegram | 钉钉 |
|------|---------|----------|------|
| Bot 创建 thread/topic | ✅ | ✅ | **❌** |
| Bot 发消息到指定 thread | ✅ | ✅ | **❌** |
| Bot 读取 thread 内消息 | ✅ | ✅ | **❌** |
| API 支持 | 完整 Thread API | 完整 Topic API | **无** |

这意味着：
- Discord 可以为每个 subagent 创建独立 thread，输出隔离展示
- Telegram 可以为每个 subagent 指定 topic，输出在 topic 内
- **钉钉只能在主聊天流里混合展示所有 agent 的消息**，通过 `[AgentName]` 前缀区分

因此，`agent_to_agent_turn` hook 对钉钉是**必要能力**——其他 channel 靠平台原生 thread 解决的"agent 间交互可见"问题，钉钉只能靠 hook 把 A2A 中间消息转发到主聊天流。

---

## 八、多实例部署：跨 Channel 的共性问题

"一个 bot 身份，路由到多个 OpenClaw 实例"不是钉钉独有的问题——**所有 channel 都面临同样的限制，且没有任何一个解决了**。

### 各 Channel 的连接模型与多实例约束

| Channel | 连接方式 | 同 token 多实例 | 冲突表现 |
|---------|---------|----------------|---------|
| Discord | WebSocket Gateway | **❌** | 新连接踢掉旧连接 |
| Telegram | Long-polling | **❌** | 409 Conflict 错误 |
| Telegram | Webhook | **理论可行** | 需外部路由 |
| Slack | Socket Mode | **❌** | 和 Discord 一样互踢 |
| Slack | HTTP Events | **理论可行** | 需外部路由 |
| DingTalk | Stream | **❌** | 连接抢占 |
| DingTalk | HTTP 回调 | **理论可行** | 需外部路由 |

### 规律

- **WebSocket/Stream/Long-polling 模式**：平台强制单连接，无法多实例
- **HTTP 模式**（webhook / 回调 / Events API）：HTTP 无状态，天然可通过反向代理路由

### OpenClaw 框架层面

- `docker-compose.yml` 是单 gateway 服务
- 无 federation、sharding、leader election 概念
- 架构假设：**一个 bot token = 一个 OpenClaw 实例**

### 解法

**方案 A：多 bot token + 多实例**（所有 channel 通用）
- 每个实例用不同的 bot token
- 零代码改动，但运维成本随实例数增长

**方案 B：HTTP 模式 + 外部路由**（仅 HTTP 模式 channel 可用）
- 适用于：Telegram webhook、Slack HTTP Events、**钉钉 HTTP 回调**
- 1 个 bot token → 外部路由代理 → N 个实例
- 需要插件支持 HTTP 接收模式 + 外部路由组件

这个问题的详细分析和钉钉 HTTP 回调方案见 [multi-agent-approach-analysis.md](./2026-03-16-multi-agent-approach-analysis.md) 第八章。

---

## 九、分阶段实施

### 阶段 1：基础 @agent 路由（PR #317，已提交）

**插件改动**：
- `agent-name-matcher.ts`：@mention → agentId 匹配
- `message-utils.ts`：提取 @mentions + 引用前缀过滤
- `inbound-handler.ts`：sub-agent 检测、路由、processSubAgentMessage

**框架能力**：
- `buildAgentSessionKey` 构造独立 session key
- 每个 agent 自动获得独立 workspace + 工具（per-agent config）

**状态**：已提交 PR #317，精简为最小路由能力。

### 阶段 2：注册框架 Adapter

**mentions adapter**：注册钉钉 @mention 的 regex 模式，让框架自动清洗发给 agent 的消息

**groups adapter**：
- `resolveRequireMention`：群内是否要求 @bot
- `resolveToolPolicy`：按群控制 allowAgents

**threading adapter**：`resolveReplyToMode` 控制回复线程行为

**配置**：

```jsonc
{
  "channels": {
    "dingtalk": {
      "groups": {
        "group-a-id": {
          "systemPrompt": "...",
          "allowAgents": ["dba", "architect", "log-expert"],
          "requireMention": true
        }
      }
    }
  }
}
```

### 阶段 3：Subagent Hooks

参考 Discord `subagent-hooks.ts`，注册三个 hook：

```typescript
// subagent-hooks.ts
export function registerDingTalkSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", async (event) => {
    if (event.requester?.channel !== "dingtalk") return;
    return { status: "ok" as const };
  });

  api.on("subagent_ended", (event) => {
    // 清理状态
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.requesterOrigin || event.requesterOrigin.channel !== "dingtalk") return;
    return {
      origin: {
        channel: "dingtalk",
        accountId: event.requesterOrigin.accountId,
        to: event.requesterOrigin.to,
      },
    };
  });
}
```

注册点（参考 Discord 的 `index.ts`）：

```typescript
register(api: OpenClawPluginApi) {
  setDingTalkRuntime(api.runtime);
  api.registerChannel({ plugin: dingtalkPlugin });
  registerDingTalkSubagentHooks(api);
}
```

此阶段后，agent 可以通过 `sessions_spawn` 调用其他 agent。结果通过 announcement 回到父 agent 并转发到群。

### 阶段 4a：插件层协作（路径 A，不依赖框架 PR）

在阶段 3 基础上，复用 `feat/expert-discussion-context` 分支：

- `extractAgentMentionsFromText`：检测 agent 回复中的 @mention → 链式触发
- `discussionLog`：累积跨轮次上下文
- `/agents` 命令：列出可用 agent

**特点**：Agent 间交互由插件驱动（检测回复中的 @mention），不是 agent 自主发起。

### 阶段 4b：框架层协作（路径 C，依赖 PR #46660）

依赖 `agent_to_agent_turn` hook 合入后，插件只需一个 handler：

```typescript
api.on("agent_to_agent_turn", (event) => {
  if (!event.requesterChannel?.includes("dingtalk")) return;
  const agentName = resolveAgentDisplayName(event.speakerSessionKey, cfg);
  sendToGroup(conversationId, `[${agentName}] ${event.reply}`);
});
```

**特点**：Agent 自主通过 `sessions_send` 发起协作，框架处理通信，插件只做消息转发。这是目标方案。

### 阶段对比

| | 阶段 4a（路径 A） | 阶段 4b（路径 C） |
|---|---|---|
| Agent 调度 | 插件驱动（@mention 链式检测） | Agent 自主（sessions_send） |
| 上下文共享 | 插件层 discussionLog | 框架 A2A 内置 |
| 中间过程可见 | 每轮发群 | A2A hook 转发到群 |
| 插件代码量 | ~200 行 | ~10 行 |
| 依赖 | 无 | PR #46660 合入 |

---

## 十、实施路线图

```
PR #317（已提交）— 基础 @mention 路由
  ↓
阶段 2 PR — 注册 mentions / groups / threading adapter
  ↓
阶段 3 PR — 注册 subagent hooks（agent 可 spawn 其他 agent）
  ↓
阶段 4a PR（路径 A）            或      阶段 4b（路径 C，依赖 #46660）
  链式 @mention 协作                    agent_to_agent_turn hook handler
  discussionLog 累积                    框架处理通信，插件只做呈现
  /agents 命令                          ~10 行代码
```

每个阶段独立可合入。阶段 4a 和 4b 是替代关系——先做 4a 快速出效果，4b 合入后切换。
