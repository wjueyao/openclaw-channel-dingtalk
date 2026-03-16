# 钉钉插件多 Agent 方案分析与建议

> 日期：2026-03-16
> 作者：wjueyao
> 背景：基于 PR #317 的讨论、《多 Bot 内部 Reroute 可行性分析》文档、以及对 OpenClaw 框架能力的深入调研

---

## 一、典型需求场景

钉钉群聊中的多 Agent 需求通常包括：

- 不同群服务不同团队，每个群需要**不同组合的专家 agent**
- 同一 agent 可能服务多个群，但各群会话独立
- 用户希望在群里**按需切换专家**
- **运维成本可控**，专家组合变化时不需要重新配置基础设施
- 可能需要**实例级别隔离**（每群独立进程/Pod）

---

## 二、两种方案概述

### 方案一：单 Bot 多 Agent（PR #317 路线）

一个钉钉 bot 作为统一入口，插件内解析 @mention 并路由到对应 agent 的独立 session。

```
用户 @DBA 帮我看看慢查询
  → 插件匹配 @DBA → agentId = "dba"
  → 路由到 dba agent 的独立 session
  → [DBA] 回复内容（同一个 bot 发出）
```

### 方案二：多 Bot 内部 Reroute
每个 agent 绑定一个独立的钉钉 bot，入口 bot 收到消息后内部转交给目标 bot 处理。

```
用户 @bot-dba 帮我看看慢查询
  → bot-dba 直接处理（或从入口 bot reroute 过来）
  → bot-dba 以自己的身份回复
```

---

## 三、关注点逐项分析

### 3.1 运维成本

| 维度 | 单 Bot 多 Agent | 多 Bot Reroute |
|------|----------------|---------------|
| 钉钉应用数量 | 1 个 | N 个（每个 agent 1 个） |
| credentials 管理 | 1 套 clientId/Secret | N 套 |
| 入群操作 | 每群拉 1 个 bot | 每群拉该群需要的所有 bot |
| 加新专家 | 改 `agents.list` 配置 | 创建新钉钉应用 + 拉入相关群 |
| 调整群的专家组合 | 改 `allowAgents` 配置 | 拉入/移除 bot |

量化示例（5 个专家、3 个群、每群平均 3 个专家）：
- 单 Bot：1 个应用、3 次入群操作
- 多 Bot：5 个应用、9 次入群操作（随规模线性增长）

**结论**：专家组合需要灵活变化时，单 Bot 运维成本显著更低。

### 3.2 用户体验

| 维度 | 单 Bot 多 Agent | 多 Bot Reroute |
|------|----------------|---------------|
| 群里 bot 数量 | 1 个 | 多个 |
| 切换专家方式 | @专家名 | @具体bot |
| 回复身份 | 同一 bot + `[专家名]` 前缀 | 不同 bot 的真实身份 |
| sessionWebhook | 可用（当前回合回复） | 跨 bot 丢失，降级为主动发送 |
| AI Card 流式回复 | 可用 | 跨 bot 后不可用 |
| "思考中..."反馈 | 可用 | 跨 bot 后不可用 |

跨 bot reroute 时，目标 bot 无法使用入口 bot 的 sessionWebhook，只能用主动发送。这意味着：

1. 回复不是"对当前消息的回复"，而是"另一个 bot 在群里发了一条新消息"
2. AI Card 的流式更新能力丢失（卡片由入口 bot 创建，目标 bot 无法操控）
3. "思考中..."等即时反馈断裂

**结论**：多 Bot 的身份清晰度更好（不同 bot 头像/名字），但交互连贯性更差。单 Bot 的 `[专家名]` 前缀是一个合理的折中。

### 3.3 架构一致性

Reroute 方案分析中指出 PR #317 "路由职责放错层"——在 channel plugin 层实现了本应属于 framework 的 @mention → agent 路由。这个批评有道理，但需要补充上下文：

1. **OpenClaw framework 目前不提供 @mention → agent 路由能力**。`bindings` 只支持 channel + accountId + peer 的静态匹配，不支持按消息内容动态路由
2. **其他 channel 插件也在插件层做类似的事**。Discord 和 Telegram 插件都有 thread-binding 和 subagent routing 逻辑，这不是钉钉独有的问题
3. **多 Bot Reroute 同样不在 framework 范围内**。内部 handoff、`InternalRerouteEnvelope`、reroute 规则都是插件层的新增概念

**结论**：两个方案都在插件层做了 framework 没覆盖的事。架构纯度的差异没有文档描述的那么大。

### 3.4 @mention 解析可靠性

Reroute 方案分析中认为 @mention 文本解析"脆弱"。实际情况：

- **richText 模式**（群聊 @ 人时钉钉默认走 richText）：`part.type === "at"` 提供精确的 `atName` + `atUserId`，**完全可靠**
- **text 模式**：需要 regex 提取，但已有防护措施：
  - 引用前缀过滤（防止引用内容中的 @xxx 被误匹配）
  - 保守启发式（有真实用户 @picker 选中时，不报告"agent 不存在"）
- 实际群聊使用中，@人操作**绑大多数走 richText**，text 模式是边缘情况

**结论**：@mention 解析在实际使用中足够可靠。

### 3.5 Session / Workspace 隔离

| 维度 | 隔离情况 |
|------|---------|
| 不同群的同一 agent 的会话 | **天然隔离**（session key 含 group ID） |
| 不同群的同一 agent 的 workspace | **共享**（同一 workspace 目录） |

纯对话 agent（不操作文件）：workspace 共享没有影响。会话隔离已天然保障。

有文件操作的 agent：可以通过不同 agent ID + 不同 workspace 路径来隔离，或者推动 OpenClaw 支持按 group 动态 workspace。

需要更彻底的隔离时：参见第八章多实例部署方案。

### 3.6 `buildAgentSessionKey` API 稳定性

Reroute 方案分析中指出 PR #317 使用了 `buildAgentSessionKey` 这个"未稳定"的 runtime API。

实际情况：
- 该 API 在 `PluginRuntimeChannel.routing` 上正式暴露（`types-channel.ts` 有明确类型定义）
- 它被 `runtime-channel.ts` 正式注册到 runtime 对象
- 其他插件代码路径也在使用同类 API

当前 TS2339 错误是由于本地 SDK 版本未更新，不是 API 本身的问题。

**结论**：该 API 事实上是公开 runtime 能力的一部分，风险可控。如果 API 变更，迁移成本也很小（只有一处调用）。

### 3.7 与 OpenClaw Session 文件的耦合

Reroute 方案分析中提到 `session-history.ts` 直接读取 JSONL 文件。

**已解决**：PR #317 最新版本已移除 `session-history.ts`，不再直接读取 OpenClaw 内部文件。历史上下文注入功能推迟到后续 PR。

---

## 四、两种方案可以结合

两个方案不是互斥的，可以设计为**分层互补**：

```
用户 @DBA → 插件匹配 agentId = "dba"
                    ↓
        该 agent 有绑定独立 bot 吗？（检查 bindings）
           ╱              ╲
          是                否
          ↓                ↓
       Reroute 到         本地处理
       目标 bot           （单 bot 模式）
          ↓                ↓
       目标 bot 回复       [DBA] 前缀回复
       （真实身份）        （同一 bot）
```

- **@mention 解析**作为统一入口（无论单 bot 还是多 bot）
- **有绑定独立 bot 时**自动走 reroute（多 bot 模式）
- **无绑定时**本地处理（单 bot 模式）
- 不需要新增配置概念，从现有 `agents.list` + `bindings` 推导

这样：
- 单 bot 用户直接可用，零额外配置
- 多 bot 用户配了 bindings 后自动升级
- 渐进增强，不互相排斥

---

## 五、后续协作演进路径

除了基础路由，多 agent 之间的**协作讨论**（专家间相互交流）也是重要方向。目前探索了两条路径：

### 路径 A：插件层协作（已有原型）

基于 @mention 链式触发 + 讨论记录累积：
- 专家 A 回复中 @专家 B → 插件检测后触发专家 B
- 每轮累积 `discussionLog`，注入下一轮专家的上下文
- 专家间能看到彼此的分析结果

分支：`feat/expert-discussion-context`

### 路径 C：框架层 A2A 协作（已提 PR）

利用 OpenClaw 内置的 agent-to-agent 消息能力：
- 专家通过 `sessions_send` 直接与其他专家通信
- 新增 `agent_to_agent_turn` plugin hook 让插件拦截每轮消息
- 插件转发到群聊，用户实时可见讨论过程

PR：[openclaw/openclaw#46660](https://github.com/openclaw/openclaw/pull/46660)

### 演进策略

```
阶段 1（当前）：基础 @agent 路由（PR #317）
    ↓
阶段 2：加 allowAgents 群级别专家可见性控制
    ↓
阶段 3a（路径 A）：插件层链式协作 + 讨论记录
    或
阶段 3b（路径 C）：框架层 A2A hook 合入后切换
    ↓
阶段 4（可选）：与多 Bot Reroute 结合（分层互补）
```

---

## 六、决策建议

| 决策点 | 建议 | 原因 |
|--------|------|------|
| 基础路由 | 单 Bot 多 Agent 作为入口层 | 运维成本低、配置灵活、sessionWebhook/Card 可用 |
| 专家配置 | `agents.list` + `bindings` + `allowAgents` | 复用现有机制，按群控制可用专家 |
| @mention 触发 | 作为统一入口 | 无论后续走单 bot 还是多 bot，都需要 @mention 解析 |
| 与多 Bot Reroute 关系 | 互补不互斥 | @mention 做入口，有绑定 bot 时走 reroute |
| 协作演进 | 先路径 A，路径 C 的 hook 合入后切换 | 路径 A 快速出效果，路径 C 架构更干净 |
| PR #317 定位 | 基础功能，后续迭代的前置 | 精简为最小路由能力，协作功能分步推进 |

---

## 七、对 Reroute 方案分析的回应

以下是对《多 Bot 内部 Reroute 可行性分析》中几个关键观点的回应：

### "PR #317 不适合作为当前主线方案"

认同 PR #317 不应**替代**多 Bot Reroute，但它作为**基础层**是合理的。@mention 路由是用户层面的通用需求，无论后端是单 bot 还是多 bot。建议将 PR #317 视为实验功能合入，为两种方案提供共同的入口层。

### "路由职责放错层"

短期内 framework 不提供 @mention → agent 路由，插件层实现是务实选择。Discord 和 Telegram 插件也有类似的插件层路由逻辑。长远看赞同上收到框架层（已提 [openclaw/openclaw#46660](https://github.com/openclaw/openclaw/pull/46660)）。

### "文本 @mention 识别不稳定"

在 richText 模式下（群聊 @ 的主要场景）识别是精确的。已有引用前缀过滤和保守启发式作为防护。实际使用中足够可靠。

### "直接读取 OpenClaw 内部 session 文件"

已在 PR #317 最新版本中移除 `session-history.ts`，不再有此耦合。

### 建议的合作方向

1. PR #317 作为实验功能合入（当前已精简为最小路由能力）
2. 并行推进多 Bot Reroute 实现
3. 两者共享 @mention 解析层（`agent-name-matcher.ts`）
4. 未来通过分层设计统一：@mention 入口 → 有绑定走 reroute / 无绑定走本地

---

## 八、多实例部署方案

当需要更彻底的隔离（进程级、文件系统级），可以将每个群部署为独立的 OpenClaw 实例/Pod。以下是四种实现思路：

### 思路 1：多钉钉应用 + 多 Pod（直接部署）

```
群 A ← "AI助手"（app-1）← OpenClaw Pod 1
群 B ← "AI助手"（app-2）← OpenClaw Pod 2
群 C ← "AI助手"（app-3）← OpenClaw Pod 3
```

多个钉钉应用可以用相同的名字和头像，用户无感知差异。

| 维度 | 说明 |
|------|------|
| 实现难度 | ★☆☆☆☆（零代码改动） |
| 钉钉应用数 | N 个（每群 1 个） |
| 隔离程度 | 完全 |
| 加新群成本 | 创建新钉钉应用（5-10 分钟，手动操作） |
| 适用规模 | < 5 个群 |

**优势**：零代码，今天就能部署。每个 Pod 完全独立。
**劣势**：钉钉应用创建无批量 API，规模大时成为瓶颈。

### 思路 2：多钉钉应用 + 容器编排

思路 1 的工程化版本，用 Docker Compose / Helm chart 简化多实例管理。加一个群 = 加一组 values。

| 维度 | 说明 |
|------|------|
| 实现难度 | ★★☆☆☆（写部署模板） |
| 钉钉应用数 | N 个 |
| 隔离程度 | 完全 |
| 适用规模 | < 10 个群 |

**优势**：一键启停，配置模板化，适合 CI/CD。
**劣势**：仍需手动创建钉钉应用。

### 思路 3：Stream 代理模式

一个代理进程持有钉钉 Stream（WebSocket）连接，按 conversationId 分发到不同 Pod。

| 维度 | 说明 |
|------|------|
| 实现难度 | ★★★★☆（高） |
| 钉钉应用数 | 1 个 |
| 隔离程度 | 完全 |
| 适用规模 | 任意 |

**核心困难**：OpenClaw 没有"接收代理转发"的 HTTP API，需要改框架或模拟协议。代理和 Pod 之间需要双向通信。

**不推荐**：工程复杂度高，OpenClaw 改动大。

### 思路 4：HTTP 回调模式 + 路由代理（推荐）

#### Stream vs HTTP：为什么当前用 Stream，以及为什么多实例需要 HTTP

钉钉机器人支持两种消息接收模式：

| | Stream 模式（当前） | HTTP 回调模式 |
|---|---|---|
| 协议 | WebSocket 长连接 | 标准 HTTP POST |
| 公网要求 | **无需公网 IP**，只要能出网 | 需要公网 HTTPS 入口 |
| 适用环境 | 个人开发机、内网、笔记本 | K8s 集群、有域名的生产环境 |
| 多实例 | **不支持**（同一组 credentials 只能维持一个连接） | **天然支持**（HTTP 无状态，可负载均衡） |
| 连接管理 | 需要心跳保活、断线重连 | 不需要（每次请求独立） |

当前插件选择 Stream 模式的核心原因是**零公网门槛**——"不想折腾公网 IP / Webhook 回调？只要机器能出网，就能把机器人稳定跑在内网、开发机、甚至笔记本上"。这是插件面向个人开发者和中小团队的核心卖点。

但 Stream 模式的单连接限制（同一组 clientId/clientSecret 只能有一个活跃 WebSocket）天然不支持多实例部署。HTTP 回调模式没有这个限制——它就是标准的 HTTP 请求，可以用任何反向代理/负载均衡器做路由和分发。

**理想状态是插件同时支持两种模式**，通过配置 `mode: "stream" | "http"` 让用户按部署环境选择：
- 个人/内网环境 → `mode: "stream"`（零公网门槛）
- K8s/生产环境 → `mode: "http"`（支持多实例、负载均衡）

#### Stream 模式当前使用的特性及 HTTP 模式影响

| Stream 特性 | 当前用途 | HTTP 模式替代方案 | 影响 |
|------------|---------|-----------------|------|
| `TOPIC_ROBOT` 消息接收 | 接收用户发给 bot 的消息 | HTTP POST body 包含相同数据 | **无影响**，完全替代 |
| `TOPIC_CARD` 卡片回调 | AI Card 反馈学习（👍/👎） | 需确认钉钉是否支持 HTTP 推送卡片事件 | **需验证**，可能丢失反馈学习 |
| `keepAlive` 心跳 | 防止连接被网络设备断开 | HTTP 无状态，不需要 | **无影响** |
| `autoReconnect` 重连 | 断线后自动重建 WebSocket | HTTP 无状态，不需要 | **无影响** |
| `socketCallBackResponse` ACK | 确认消息已收到，防止重复投递 | HTTP 200 响应等效 | **无影响** |
| `sessionWebhook` 当前回合回复 | 消息体自带的回复 URL | HTTP POST body 中同样包含 | **无影响**，各 Pod 可直接回复 |

核心功能（消息接收 → AI 处理 → 回复）在 HTTP 模式下**完全可用**。唯一需要验证的是 `TOPIC_CARD` 卡片交互回调是否在 HTTP 模式下也能接收。

#### 架构

切到 HTTP 回调后，可以用标准的反向代理按 conversationId 路由到不同 Pod。

```
钉钉 ──POST──► 路由代理 Pod（解析 body.conversationId，按路由表转发）
                  ├─ group-a → OpenClaw Pod 1（HTTP 接收模式）
                  ├─ group-b → OpenClaw Pod 2
                  └─ group-c → OpenClaw Pod 3
                  回复不走代理，各 Pod 用 sessionWebhook 直接回复钉钉
```

| 维度 | 说明 |
|------|------|
| 实现难度 | ★★★☆☆（中等） |
| 钉钉应用数 | **1 个** |
| 隔离程度 | 完全 |
| 加新群成本 | **改路由表 ConfigMap（1 分钟）** |
| 适用规模 | **任意** |

关键设计：
- **回复不经过代理**：各 Pod 用 `sessionWebhook` 直接回复钉钉。代理无状态，可多副本
- **核心逻辑完全复用**：插件新增 HTTP 接收入口，调用现有 `handleDingTalkMessage`
- **路由代理极简**：按 `conversationId` 查表转发，约 60 行代码

需要开发：
| 组件 | 工作量 | 说明 |
|------|--------|------|
| 插件 HTTP 接收模式 | ~100 行，1 天 | HTTP server + 验签 + 调用现有 handler |
| 消息路由代理 | ~60 行，0.5 天 | 按 conversationId 转发 |
| 部署模板 | 0.5 天 | Helm chart / Kustomize |
| 联调测试 | 1 天 | 端到端验证 |
| **总计** | **约 3 天** | |

**优势**：

1. **1 个钉钉应用支撑任意规模**。不再有"群数 = 应用数"的线性增长问题。无论 5 个群还是 50 个群，都只需要维护 1 套 credentials、1 个钉钉应用配置。钉钉开放平台上也不会出现大量应用需要管理。
2. **加群只需改配置**。新增群只需在路由表（ConfigMap）中添加一行 `conversationId → Pod` 映射，不需要任何钉钉开放平台操作。配合 K8s 部署模板，新增一个群 = 新增一组 Helm values + 更新 ConfigMap，可以完全自动化。
3. **HTTP 接收模式可作为独立 feature 贡献**。当前钉钉插件只支持 Stream 模式，HTTP 回调模式是钉钉官方支持的另一种接入方式。将其作为插件的标准能力，不仅服务于多实例场景，也适用于：无法维持长连接的环境（Serverless/FaaS）、需要标准 HTTP 负载均衡的企业网关部署、更易于调试和监控的生产环境（HTTP 请求有标准的日志和链路追踪支持）。
4. **代理无状态，天然高可用**。路由代理只做 HTTP 转发，不持有任何状态，可以多副本部署。任何一个代理实例挂掉，负载均衡自动切到其他实例，不影响服务。
5. **回复路径不经过代理**。各 Pod 用消息体中自带的 `sessionWebhook` 直接回复钉钉，回复延迟不受代理层影响。代理层的故障也不会阻断正在进行的对话回复。

**劣势**：

1. **需要公网 HTTPS 入口**。钉钉 HTTP 回调模式要求回调 URL 必须是 HTTPS，因此需要：公网域名 + TLS 证书 + 反向代理（Nginx/Traefik/K8s Ingress）。对于已有 K8s 集群和域名的环境，这不是额外成本；对于纯内网或个人开发环境，可能需要用 ngrok/frp 等内网穿透工具。相比 Stream 模式"无需公网 IP"的零门槛，HTTP 模式有明确的基础设施前置要求。
2. **Stream 模式的某些特性不可用**。当前 Stream 模式下钉钉的 DWClient 提供了 keepAlive 心跳、自动重连、服务端主动推送等能力。切到 HTTP 回调模式后：心跳和重连不再需要（HTTP 是无状态的，每次请求独立）；服务端主动推送（如果有）需要改为轮询或其他机制。不过对于当前插件的主要功能（接收消息 → AI 处理 → 回复），HTTP 回调完全能覆盖，Stream 独有的特性在实际使用中影响很小。
3. **增加一跳网络延迟**。请求经过路由代理层会增加一次网络转发，通常在 1-5ms 量级。对于 AI 对话场景（回复延迟通常以秒计），这个延迟完全可以忽略。但在极端高并发下，代理层可能成为性能瓶颈，需要关注代理的水平扩展能力。

### 四种方案总览

| | 思路 1 多应用直接部署 | 思路 2 多应用+编排 | 思路 3 Stream 代理 | 思路 4 HTTP 回调+代理 |
|---|---|---|---|---|
| 钉钉应用数 | N | N | 1 | **1** |
| 代码改动 | 零 | 零 | 大 | **~150 行** |
| 加新群 | 手动建应用 | 手动建应用 | 改配置 | **改配置** |
| 适用规模 | < 5 | < 10 | 任意 | **任意** |
| 实现难度 | ★ | ★★ | ★★★★ | **★★★** |
| 推荐场景 | 快速验证 | 小规模生产 | 不推荐 | **规模化生产** |

建议策略：
```
起步（< 5 群）→ 思路 1 或 2，零代码快速跑起来
增长（> 5 群）→ 投入 3 天开发思路 4，一劳永逸
```

所有思路都与单 Bot 多 Agent 兼容。每个 Pod 内部仍可运行 `agents.list` + `allowAgents`，实现"实例级隔离 + 群内多专家切换"。

---

## 附：当前分支状态

| 分支 | 状态 | 说明 |
|------|------|------|
| `feat/at-agent-basic` | PR #317 待合入 | 基础 @agent 路由（已精简） |
| `feat/expert-discussion-context` | 开发中 | 路径 A：链式协作 + 讨论记录 |
| `feat/a2a-turn-hook`（openclaw） | PR #46660 待合入 | 路径 C：A2A hook |
