# 阶段 2：allowAgents — 按群控制可用 Agent

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 支持按群配置 `allowAgents`，控制每个群内哪些 agent 可以通过 @mention 触发。

**Architecture:** 在 `resolveGroupConfig` 返回值中扩展 `allowAgents` 字段，`resolveAtAgents` 新增过滤参数，路由层从 group config 读取并传入。纯插件层改动，不涉及 OpenClaw 框架。

**Tech Stack:** TypeScript, Vitest

---

## 与路径 A（expert-discussion）的关系

| 维度 | 路径 A（expert-discussion 分支） | 阶段 2（本次） |
|------|--------------------------------|---------------|
| 核心能力 | 链式 @mention 协作 + discussionLog 上下文共享 | 按群控制可用 agent |
| 依赖 | 阶段 1（PR #317） | 阶段 1（PR #317） |
| 功能范围 | agent 间交互（agent A @agent B → 链式触发） | agent 可见性过滤（群 X 只能 @agent A 和 B） |
| 代码位置 | `src/targeting/agent-routing.ts`（协作循环） | `src/targeting/agent-name-matcher.ts`（过滤）+ `src/config.ts`（配置） |
| 互相影响 | **不冲突** | **不冲突** |

两者是独立的功能维度：
- `allowAgents` 控制的是"谁能被触发"
- 路径 A 控制的是"触发后 agent 之间怎么交流"

可以独立合入，也可以在路径 A 之上叠加 `allowAgents`。

---

## 为什么不做 mentions adapter 和 threading adapter

原计划阶段 2 包含注册 mentions / threading adapter，经评估后移除：

**mentions adapter**（`stripPatterns`）：框架会自动从发给 agent 的消息中去掉 @标记。但钉钉场景下 agent 看到原始 @mention 是有用的——比如"@DBA @网络 帮忙看看"，DBA agent 需要知道网络也被 @了，以便协调。strip 掉反而丢失信息。

**threading adapter**（`resolveReplyToMode`）：钉钉没有原生 thread，注册 `"off"` 只是告诉框架不做 thread 回复。当前不注册也不影响功能，加了没有实质效果。

这两个在有明确需求时再加。

---

## 配置示例

```jsonc
{
  "channels": {
    "dingtalk": {
      "groups": {
        "group-db-team": {
          "allowAgents": ["dba", "architect", "log-expert"],
          "systemPrompt": "这是数据库团队群"
        },
        "group-frontend": {
          "allowAgents": ["frontend", "ui-design"],
          "systemPrompt": "这是前端团队群"
        },
        "*": {
          // 通配符：未单独配置的群，默认允许所有 agent
          // 不设 allowAgents = 不过滤
        }
      }
    }
  }
}
```

**行为规则**：
- `allowAgents` 存在 → 只有列表中的 agent 可以被 @mention 触发
- `allowAgents` 不存在或为空 → 所有 `agents.list` 中的 agent 都可被触发
- 被过滤掉的 agent @mention 不会触发 "未找到助手" 提示（因为 agent 存在，只是当前群不可用）

---

## 实施计划

### Task 1: 扩展 group config 类型

**Files:**
- Modify: `src/config.ts`
- Test: `tests/unit/config-schema.test.ts`

**Step 1: Write the failing test**

在 `tests/unit/config-schema.test.ts` 新增：

```typescript
it("resolveGroupConfig returns allowAgents from group config", () => {
  const cfg = getConfig(
    {
      channels: {
        dingtalk: {
          groups: {
            "group-1": { allowAgents: ["dba", "network"] },
          },
        },
      },
    },
    "default",
  );
  const groupCfg = resolveGroupConfig(cfg, "group-1");
  expect(groupCfg?.allowAgents).toEqual(["dba", "network"]);
});

it("resolveGroupConfig returns undefined allowAgents when not configured", () => {
  const cfg = getConfig(
    {
      channels: {
        dingtalk: {
          groups: {
            "group-1": { systemPrompt: "test" },
          },
        },
      },
    },
    "default",
  );
  const groupCfg = resolveGroupConfig(cfg, "group-1");
  expect(groupCfg?.allowAgents).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/config-schema.test.ts -t "allowAgents"
```

**Step 3: Update resolveGroupConfig return type**

`src/config.ts`：

```typescript
export function resolveGroupConfig(
  cfg: DingTalkConfig,
  groupId: string,
): { systemPrompt?: string; allowAgents?: string[]; requireMention?: boolean } | undefined {
  const groups = cfg.groups;
  if (!groups) {
    return undefined;
  }
  return groups[groupId] || groups["*"] || undefined;
}
```

确保 `DingTalkConfig` 中 `groups` 的类型也支持 `allowAgents`（在 `src/types.ts` 中）。

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/config-schema.test.ts
```

**Step 5: Commit**

```bash
git add src/config.ts src/types.ts tests/unit/config-schema.test.ts
git commit -m "feat: add allowAgents to group config"
```

---

### Task 2: resolveAtAgents 支持 allowAgents 过滤

**Files:**
- Modify: `src/targeting/agent-name-matcher.ts`
- Test: `tests/unit/agent-name-matcher.test.ts`

**Step 1: Write the failing tests**

```typescript
it("filters matched agents by allowAgents", () => {
  const result = resolveAtAgents(
    [{ name: "dba" }, { name: "network" }, { name: "frontend" }],
    { agents: { list: [
      { id: "dba", name: "dba" },
      { id: "network", name: "network" },
      { id: "frontend", name: "frontend" },
    ] } } as any,
    undefined,
    ["dba", "network"],
  );
  expect(result.matchedAgents).toHaveLength(2);
  expect(result.matchedAgents.map(a => a.agentId)).toEqual(["dba", "network"]);
});

it("does not filter when allowAgents is undefined", () => {
  const result = resolveAtAgents(
    [{ name: "dba" }, { name: "frontend" }],
    { agents: { list: [
      { id: "dba", name: "dba" },
      { id: "frontend", name: "frontend" },
    ] } } as any,
  );
  expect(result.matchedAgents).toHaveLength(2);
});

it("filtered-out agents do not trigger hasInvalidAgentNames", () => {
  const result = resolveAtAgents(
    [{ name: "frontend" }],
    { agents: { list: [
      { id: "dba", name: "dba" },
      { id: "frontend", name: "frontend" },
    ] } } as any,
    undefined,
    ["dba"], // frontend exists but not allowed
  );
  expect(result.matchedAgents).toHaveLength(0);
  // frontend is a valid agent, just not allowed — should NOT trigger "not found" warning
  expect(result.hasInvalidAgentNames).toBe(false);
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/agent-name-matcher.test.ts -t "allowAgents"
```

**Step 3: Add allowAgents parameter**

`src/targeting/agent-name-matcher.ts`：

```typescript
export function resolveAtAgents(
  atMentions: AtMention[],
  cfg: OpenClawConfig,
  atUserDingtalkIds?: string[],
  allowAgents?: string[], // NEW
): { ... } {
  // ... existing matching logic ...

  // After matching, filter by allowAgents if provided.
  // Filtered-out agents are valid (exist in agents.list) but not allowed in this group,
  // so they should NOT trigger hasInvalidAgentNames.
  const filteredAgents = allowAgents
    ? matchedAgents.filter(a => allowAgents.includes(a.agentId))
    : matchedAgents;

  // Recalculate hasInvalidAgentNames: only consider truly unmatched names,
  // not agents that matched but were filtered by allowAgents
  const filteredOutCount = matchedAgents.length - filteredAgents.length;
  const hasInvalidAgentNames = realUserCount === 0
    && unmatchedNames.length > 0
    && filteredOutCount === 0; // don't report invalid if some were just filtered

  return {
    matchedAgents: filteredAgents,
    unmatchedNames,
    mainAgentId,
    realUserCount,
    hasInvalidAgentNames,
  };
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/unit/agent-name-matcher.test.ts
```

**Step 5: Commit**

```bash
git add src/targeting/agent-name-matcher.ts tests/unit/agent-name-matcher.test.ts
git commit -m "feat: add allowAgents filtering to resolveAtAgents"
```

---

### Task 3: 路由层传递 allowAgents

**Files:**
- Modify: `src/targeting/agent-routing.ts`
- Modify: `src/inbound-handler.ts`

**Step 1: Update resolveSubAgentRoute to accept allowAgents**

`src/targeting/agent-routing.ts`：

```typescript
export async function resolveSubAgentRoute(params: {
  // ... existing params ...
  allowAgents?: string[];
}): Promise<...> {
  // ...
  const { matchedAgents, ... } = resolveAtAgents(
    atMentions,
    cfg,
    atUserDingtalkIds,
    params.allowAgents,
  );
  // ...
}
```

**Step 2: Update inbound-handler to pass allowAgents**

`src/inbound-handler.ts`：

```typescript
if (!subAgentOptions) {
  const groupConfig = isGroup ? resolveGroupConfig(dingtalkConfig, groupId) : undefined;
  const subAgentRoute = await resolveSubAgentRoute({
    extractedContent,
    cfg,
    isGroup,
    dingtalkConfig,
    sessionWebhook,
    senderId,
    allowAgents: groupConfig?.allowAgents,
    log,
  });
  // ...
}
```

需要在文件顶部 import `resolveGroupConfig`（如果尚未导入）。

**Step 3: Run all tests**

```bash
npx vitest run
```

**Step 4: Commit**

```bash
git add src/targeting/agent-routing.ts src/inbound-handler.ts
git commit -m "feat: wire allowAgents from group config through routing"
```

---

### Task 4: 集成测试

**Files:**
- Modify: `tests/unit/inbound-handler.test.ts`

**Step 1: Write integration test**

```typescript
it("respects allowAgents — only allowed agents are routed in group", async () => {
  const runtime = buildRuntime();
  shared.getRuntimeMock.mockReturnValueOnce(runtime);
  shared.extractMessageContentMock.mockReturnValue({
    text: "@dba @frontend help",
    messageType: "text",
    atMentions: [{ name: "dba" }, { name: "frontend" }],
  });

  await handleDingTalkMessage({
    cfg: {
      agents: {
        list: [
          { id: "dba", name: "dba" },
          { id: "frontend", name: "frontend" },
        ],
      },
    },
    accountId: "main",
    sessionWebhook: "https://session.webhook",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    dingtalkConfig: {
      dmPolicy: "open",
      messageType: "markdown",
      showThinking: false,
      groups: {
        "group_1": { allowAgents: ["dba"] },
      },
    } as any,
    data: {
      msgId: "aa1",
      msgtype: "text",
      text: { content: "@dba @frontend help" },
      conversationType: "2",
      conversationId: "group_1",
      senderId: "u1",
      chatbotUserId: "bot_1",
      sessionWebhook: "https://session.webhook",
      createAt: Date.now(),
    },
  } as any);

  // Only dba should be dispatched (1 call), frontend filtered out
  const dispatchCalls = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls;
  expect(dispatchCalls).toHaveLength(1);
});

it("allows all agents when allowAgents is not configured for group", async () => {
  const runtime = buildRuntime();
  shared.getRuntimeMock.mockReturnValueOnce(runtime);
  // ... similar setup but without groups config ...
  // Both dba and frontend should be dispatched
});
```

**Step 2: Run tests**

```bash
npx vitest run tests/unit/inbound-handler.test.ts -t "allowAgents"
```

**Step 3: Commit**

```bash
git add tests/unit/inbound-handler.test.ts
git commit -m "test: add allowAgents integration tests"
```

---

### Task 5: 全量测试 + 推送

```bash
npx vitest run
git push origin feat/dingtalk-allowAgents
```
