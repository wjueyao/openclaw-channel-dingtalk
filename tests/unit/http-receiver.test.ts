import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttpReceiver } from "../../src/http-receiver";
import { generateDingTalkSignature } from "../../src/signature";

vi.mock("../../src/inbound-handler", () => ({
  handleDingTalkMessage: vi.fn().mockResolvedValue(undefined),
}));

import { handleDingTalkMessage } from "../../src/inbound-handler";

const mockedHandle = vi.mocked(handleDingTalkMessage);
const INGRESS_SECRET = "secret";

function createSignedHeaders(secret: string, timestamp = Date.now().toString()): Record<string, string> {
  return {
    timestamp,
    sign: generateDingTalkSignature(timestamp, secret),
  };
}

function post(
  port: number,
  path: string,
  body: unknown,
  options?: {
    headers?: Record<string, string>;
    rawBody?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = options?.rawBody ?? JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(options?.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject);
  });
}

describe("http-receiver", () => {
  let server: http.Server;
  const port = 19876; // use a high port to avoid conflicts

  beforeEach(() => {
    mockedHandle.mockReset();
    mockedHandle.mockResolvedValue(undefined);
  });

  afterEach(() => {
    server?.close();
  });

  it("processes POST /callback and calls handleDingTalkMessage", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test-account",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100)); // wait for server to start

    const message = {
      msgId: "msg-1",
      msgtype: "text",
      text: { content: "hello" },
      conversationType: "2",
      conversationId: "group-1",
      senderId: "user-1",
      chatbotUserId: "bot-1",
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      createAt: Date.now(),
    };

    const res = await post(port, "/dingtalk/callback", message, {
      headers: createSignedHeaders(INGRESS_SECRET),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(mockedHandle).toHaveBeenCalledTimes(1);
    expect(mockedHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "test-account",
        data: expect.objectContaining({ msgId: "msg-1", conversationId: "group-1" }),
        sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      }),
    );
  });

  it("returns 404 for non-callback paths", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/other", {});
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      log: { warn: vi.fn() } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", {}, {
      headers: createSignedHeaders(INGRESS_SECRET),
      rawBody: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("responds to GET /health", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(port, "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, mode: "http", accountId: "test" });
  });

  it("accepts custom webhookPath", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      webhookPath: "/custom/webhook",
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/custom/webhook", { msgId: "m2", sessionWebhook: "https://x" }, {
      headers: createSignedHeaders(INGRESS_SECRET),
    });
    expect(res.status).toBe(200);

    // Default path should 404
    const res2 = await post(port, "/dingtalk/callback", { msgId: "m3", sessionWebhook: "https://x" });
    expect(res2.status).toBe(404);
  });

  it("returns 401 or 403 when signature headers are missing", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", { msgId: "m-missing-sign", sessionWebhook: "https://x" });

    expect([401, 403]).toContain(res.status);
    expect(mockedHandle).not.toHaveBeenCalled();
  });

  it("returns 401 or 403 when signature is invalid", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", { msgId: "m-invalid-sign", sessionWebhook: "https://x" }, {
      headers: {
        timestamp: Date.now().toString(),
        sign: "invalid-sign",
      },
    });

    expect([401, 403]).toContain(res.status);
    expect(mockedHandle).not.toHaveBeenCalled();
  });

  it("returns 401 or 403 when timestamp is invalid", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", { msgId: "m-invalid-timestamp", sessionWebhook: "https://x" }, {
      headers: {
        timestamp: "not-a-timestamp",
        sign: "invalid-sign",
      },
    });

    expect([401, 403]).toContain(res.status);
    expect(mockedHandle).not.toHaveBeenCalled();
  });

  it("returns 413 when request body exceeds limit", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      log: { warn: vi.fn() } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const oversized = JSON.stringify({
      msgId: "m-oversized",
      sessionWebhook: "https://x",
      text: {
        content: "x".repeat(1_048_577),
      },
    });

    const res = await post(port, "/dingtalk/callback", {}, {
      headers: createSignedHeaders(INGRESS_SECRET),
      rawBody: oversized,
    });

    expect(res.status).toBe(413);
    expect(mockedHandle).not.toHaveBeenCalled();
  });

  it("still returns success response even when handleDingTalkMessage throws", async () => {
    mockedHandle.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const errorLog = vi.fn();
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      log: { error: errorLog } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(
      port,
      "/dingtalk/callback",
      {
        msgId: "m-throw",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "group-1",
        senderId: "user-1",
        chatbotUserId: "bot-1",
        sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=yyy",
        createAt: Date.now(),
      },
      {
        headers: createSignedHeaders(INGRESS_SECRET),
      },
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    await new Promise((r) => setTimeout(r, 50));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Failed to process message"));
  });
});
