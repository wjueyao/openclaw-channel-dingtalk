# HTTP 回调模式实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为钉钉插件新增 HTTP 回调接收模式，支持多实例部署。通过配置 `mode: "http"` 切换，与现有 Stream 模式并存。

**Architecture:** 新增 `src/http-receiver.ts`，启动 HTTP server 监听 POST 请求，解析钉钉回调 body 后调用现有 `handleDingTalkMessage`。在 `channel.ts` 的 `startAccount` 中根据 `mode` 配置决定走 Stream 还是 HTTP。核心处理逻辑完全复用。

**Tech Stack:** TypeScript, Node.js http 模块, Vitest

---

## Task 1: 添加配置字段

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config-schema.ts`

在 `DingTalkConfig` 中新增：

```typescript
/** 消息接收模式：stream（默认）或 http */
mode?: "stream" | "http";
/** HTTP 模式监听端口（默认 3000） */
httpPort?: number;
```

---

## Task 2: 实现 HTTP receiver

**Files:**
- Create: `src/http-receiver.ts`
- Test: `tests/unit/http-receiver.test.ts`

HTTP server 接收 POST `/callback`，解析 body，调用 `handleDingTalkMessage`。
复用 channel.ts 中的 dedup 逻辑（`isMessageProcessed`、`markMessageProcessed`）。

---

## Task 3: 在 channel.ts 中集成

**Files:**
- Modify: `src/channel.ts`

在 `startAccount` 中根据 `config.mode` 分支：
- `"stream"`（默认）：走现有 DWClient 逻辑
- `"http"`：启动 HTTP receiver

---

## Task 4: 测试 + 推送

全量测试通过后推送分支。
