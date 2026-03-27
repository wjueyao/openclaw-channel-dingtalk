import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { isMessageProcessed, markMessageProcessed } from "./dedup";
import { handleDingTalkMessage } from "./inbound-handler";
import type { DingTalkConfig, DingTalkInboundMessage, Logger } from "./types";

const INFLIGHT_TTL_MS = 5 * 60 * 1000; // 5 min safety net for hung handlers
type InflightEntry = {
  since: number;
  completion: Promise<boolean>;
  settle: (succeeded: boolean) => void;
};
const processingDedupKeys = new Map<string, InflightEntry>(); // key -> inflight metadata

export type InboundInFlightPolicy = "skip" | "wait";

export type InboundDispatchGuardResult =
  | { status: "processed" }
  | { status: "dedup_skipped" }
  | { status: "inflight_skipped" };

export type InboundDispatchGuardHooks = {
  onMissingMessageId?: () => void;
  onDedupSkipped?: (dedupKey: string) => void;
  onInflightSkipped?: (dedupKey: string) => void;
  onStaleInflightReleased?: (ctx: { dedupKey: string; heldMs: number; ttlMs: number }) => void;
};

export async function dispatchInboundMessageWithGuard(params: {
  cfg: OpenClawConfig;
  accountId: string;
  data: DingTalkInboundMessage;
  sessionWebhook?: string;
  log?: Logger;
  dingtalkConfig: DingTalkConfig;
  robotCode?: string;
  clientId?: string;
  msgId?: string;
  inFlightPolicy?: InboundInFlightPolicy;
  hooks?: InboundDispatchGuardHooks;
}): Promise<InboundDispatchGuardResult> {
  const {
    cfg,
    accountId,
    data,
    sessionWebhook,
    log,
    dingtalkConfig,
    robotCode,
    clientId,
    msgId,
    inFlightPolicy = "skip",
    hooks,
  } = params;
  const robotKey = robotCode || clientId || accountId;
  const effectiveMsgId = (msgId || "").trim();
  const dedupKey = effectiveMsgId ? `${robotKey}:${effectiveMsgId}` : undefined;

  if (!dedupKey) {
    hooks?.onMissingMessageId?.();
    await handleDingTalkMessage({
      cfg,
      accountId,
      data,
      sessionWebhook,
      log,
      dingtalkConfig,
    });
    return { status: "processed" };
  }

  if (isMessageProcessed(dedupKey)) {
    hooks?.onDedupSkipped?.(dedupKey);
    return { status: "dedup_skipped" };
  }

  while (true) {
    const inflight = processingDedupKeys.get(dedupKey);
    if (inflight !== undefined) {
      const heldMs = Date.now() - inflight.since;
      if (heldMs > INFLIGHT_TTL_MS) {
        hooks?.onStaleInflightReleased?.({ dedupKey, heldMs, ttlMs: INFLIGHT_TTL_MS });
        processingDedupKeys.delete(dedupKey);
        continue;
      }

      if (inFlightPolicy === "skip") {
        hooks?.onInflightSkipped?.(dedupKey);
        return { status: "inflight_skipped" };
      }

      const completedSuccessfully = await inflight.completion;
      if (completedSuccessfully && isMessageProcessed(dedupKey)) {
        hooks?.onDedupSkipped?.(dedupKey);
        return { status: "dedup_skipped" };
      }
      continue;
    }

    let settleInflight!: (succeeded: boolean) => void;
    const nextInflight: InflightEntry = {
      since: Date.now(),
      completion: new Promise<boolean>((resolve) => {
        settleInflight = resolve;
      }),
      settle: (succeeded: boolean) => settleInflight(succeeded),
    };
    processingDedupKeys.set(dedupKey, nextInflight);

    try {
      await handleDingTalkMessage({
        cfg,
        accountId,
        data,
        sessionWebhook,
        log,
        dingtalkConfig,
      });
      markMessageProcessed(dedupKey);
      nextInflight.settle(true);
      return { status: "processed" };
    } catch (error) {
      nextInflight.settle(false);
      throw error;
    } finally {
      if (processingDedupKeys.get(dedupKey) === nextInflight) {
        processingDedupKeys.delete(dedupKey);
      }
    }
  }
}

export function clearInboundDispatchInFlightLocks(robotKey: string): number {
  let cleared = 0;
  for (const key of processingDedupKeys.keys()) {
    if (key.startsWith(`${robotKey}:`)) {
      processingDedupKeys.delete(key);
      cleared++;
    }
  }
  return cleared;
}
