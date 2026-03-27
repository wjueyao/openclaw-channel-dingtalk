import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { isMessageProcessed, markMessageProcessed } from "./dedup";
import { handleDingTalkMessage } from "./inbound-handler";
import type { DingTalkConfig, DingTalkInboundMessage, Logger } from "./types";

const INFLIGHT_TTL_MS = 5 * 60 * 1000; // 5 min safety net for hung handlers
const processingDedupKeys = new Map<string, { since: number; active: number }>(); // key -> inflight metadata

export type InboundInFlightPolicy = "skip" | "process";

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

  const inflightSince = processingDedupKeys.get(dedupKey);
  if (inflightSince !== undefined) {
    const heldMs = Date.now() - inflightSince.since;
    if (heldMs > INFLIGHT_TTL_MS) {
      hooks?.onStaleInflightReleased?.({ dedupKey, heldMs, ttlMs: INFLIGHT_TTL_MS });
      processingDedupKeys.delete(dedupKey);
    } else if (inFlightPolicy === "skip") {
      hooks?.onInflightSkipped?.(dedupKey);
      return { status: "inflight_skipped" };
    } else {
      processingDedupKeys.set(dedupKey, {
        since: inflightSince.since,
        active: inflightSince.active + 1,
      });
    }
  } else {
    processingDedupKeys.set(dedupKey, { since: Date.now(), active: 1 });
  }

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
    return { status: "processed" };
  } finally {
    const inflight = processingDedupKeys.get(dedupKey);
    if (inflight) {
      if (inflight.active <= 1) {
        processingDedupKeys.delete(dedupKey);
      } else {
        processingDedupKeys.set(dedupKey, { since: inflight.since, active: inflight.active - 1 });
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
