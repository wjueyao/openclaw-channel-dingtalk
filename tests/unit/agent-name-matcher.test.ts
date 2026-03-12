import { describe, expect, it } from "vitest";
import {
  getMainAgentId,
  resolveAtAgents,
  extractAgentMentionsFromText,
  formatAgentList,
} from "../../src/agent-name-matcher";
import type { AtMention } from "../../src/types";

describe("agent-name-matcher", () => {
  describe("getMainAgentId", () => {
    it("returns 'main' when agents list is undefined", () => {
      expect(getMainAgentId(undefined)).toBe("main");
    });

    it("returns 'main' when agents list is empty", () => {
      expect(getMainAgentId([])).toBe("main");
    });

    it("returns the default agent id when marked as default", () => {
      const agents = [
        { id: "assistant", name: "助手", default: true },
        { id: "translator", name: "翻译" },
      ];
      expect(getMainAgentId(agents)).toBe("assistant");
    });

    it("returns first agent id when no default is marked", () => {
      const agents = [
        { id: "first", name: "第一个" },
        { id: "second", name: "第二个" },
      ];
      expect(getMainAgentId(agents)).toBe("first");
    });
  });

  describe("resolveAtAgents", () => {
    const createConfig = (agents: Array<{ id: string; name?: string; default?: boolean }>) => ({
      agents: { list: agents },
    });

    it("returns empty results when atMentions is empty", () => {
      const cfg = createConfig([{ id: "main", name: "助手", default: true }]);
      const result = resolveAtAgents([], cfg);

      expect(result.matchedAgents).toEqual([]);
      expect(result.unmatchedNames).toEqual([]);
      expect(result.mainAgentId).toBe("main");
    });

    it("matches agent by name field", () => {
      const cfg = createConfig([
        { id: "main", name: "助手", default: true },
        { id: "frontend", name: "前端专家" },
      ]);
      const atMentions: AtMention[] = [{ name: "前端专家" }];

      const result = resolveAtAgents(atMentions, cfg);

      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe("frontend");
      expect(result.matchedAgents[0].matchSource).toBe("name");
    });

    it("matches agent by id field", () => {
      const cfg = createConfig([
        { id: "main", name: "助手", default: true },
        { id: "backend", name: "后端专家" },
      ]);
      const atMentions: AtMention[] = [{ name: "backend" }];

      const result = resolveAtAgents(atMentions, cfg);

      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe("backend");
      expect(result.matchedAgents[0].matchSource).toBe("id");
    });

    it("matching is case-insensitive", () => {
      const cfg = createConfig([
        { id: "Frontend", name: "前端专家" },
      ]);
      const atMentions: AtMention[] = [{ name: "FRONTEND" }];

      const result = resolveAtAgents(atMentions, cfg);

      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe("Frontend");
    });

    it("excludes duplicate agent matches", () => {
      const cfg = createConfig([
        { id: "frontend", name: "前端专家" },
      ]);
      const atMentions: AtMention[] = [
        { name: "frontend" },
        { name: "前端专家" },
      ];

      const result = resolveAtAgents(atMentions, cfg);

      expect(result.matchedAgents).toHaveLength(1);
    });

    it("reports unmatched names for non-agent mentions", () => {
      const cfg = createConfig([
        { id: "main", name: "助手", default: true },
      ]);
      const atMentions: AtMention[] = [
        { name: "不存在的专家" },
      ];

      const result = resolveAtAgents(atMentions, cfg);

      expect(result.matchedAgents).toHaveLength(0);
      expect(result.unmatchedNames).toEqual(["不存在的专家"]);
    });

    it("excludes real users (with userId) from unmatched names", () => {
      const cfg = createConfig([
        { id: "main", name: "助手", default: true },
      ]);
      const atMentions: AtMention[] = [
        { name: "张三", userId: "user123" },
        { name: "不存在的专家" },
      ];

      const result = resolveAtAgents(atMentions, cfg);

      expect(result.unmatchedNames).toEqual(["不存在的专家"]);
    });

    it("handles multiple mixed mentions", () => {
      const cfg = createConfig([
        { id: "main", name: "助手", default: true },
        { id: "frontend", name: "前端专家" },
        { id: "backend", name: "后端专家" },
      ]);
      const atMentions: AtMention[] = [
        { name: "前端专家" },
        { name: "张三", userId: "user123" },
        { name: "backend" },
        { name: "不存在的" },
      ];

      const result = resolveAtAgents(atMentions, cfg);

      expect(result.matchedAgents).toHaveLength(2);
      expect(result.matchedAgents.map((m) => m.agentId)).toEqual(
        expect.arrayContaining(["frontend", "backend"])
      );
      expect(result.unmatchedNames).toEqual(["不存在的"]);
    });
  });

  describe("extractAgentMentionsFromText", () => {
    const createConfig = (agents: Array<{ id: string; name?: string }>) => ({
      agents: { list: agents },
    });

    it("returns empty array when no agents configured", () => {
      expect(extractAgentMentionsFromText("@frontend 你好", {})).toEqual([]);
    });

    it("returns empty array when text is empty", () => {
      const cfg = createConfig([{ id: "frontend", name: "前端专家" }]);
      expect(extractAgentMentionsFromText("", cfg)).toEqual([]);
    });

    it("extracts single agent mention", () => {
      const cfg = createConfig([
        { id: "frontend", name: "前端专家" },
        { id: "backend", name: "后端专家" },
      ]);

      const result = extractAgentMentionsFromText("我觉得 @backend 你应该看看", cfg);

      expect(result).toEqual(["backend"]);
    });

    it("extracts multiple agent mentions", () => {
      const cfg = createConfig([
        { id: "frontend", name: "前端专家" },
        { id: "backend", name: "后端专家" },
      ]);

      const result = extractAgentMentionsFromText(
        "@前端专家 和 @backend 你们怎么看？",
        cfg
      );

      expect(result).toHaveLength(2);
      expect(result).toEqual(expect.arrayContaining(["frontend", "backend"]));
    });

    it("excludes specified agent IDs", () => {
      const cfg = createConfig([
        { id: "frontend", name: "前端专家" },
        { id: "backend", name: "后端专家" },
      ]);

      const result = extractAgentMentionsFromText(
        "@frontend @backend 你好",
        cfg,
        ["frontend"]
      );

      expect(result).toEqual(["backend"]);
    });

    it("deduplicates mentions", () => {
      const cfg = createConfig([
        { id: "frontend", name: "前端专家" },
      ]);

      const result = extractAgentMentionsFromText(
        "@frontend @frontend @前端专家 重复了",
        cfg
      );

      expect(result).toEqual(["frontend"]);
    });

    it("ignores non-agent mentions", () => {
      const cfg = createConfig([
        { id: "frontend", name: "前端专家" },
      ]);

      const result = extractAgentMentionsFromText(
        "@张三 @不存在的 @frontend 你好",
        cfg
      );

      expect(result).toEqual(["frontend"]);
    });
  });

  describe("formatAgentList", () => {
    it("returns message when no agents configured", () => {
      expect(formatAgentList({})).toBe("当前没有配置专家助手。");
    });

    it("returns message when agents list is empty", () => {
      expect(formatAgentList({ agents: { list: [] } })).toBe(
        "当前没有配置专家助手。"
      );
    });

    it("formats single agent with default badge", () => {
      const cfg = {
        agents: {
          list: [{ id: "main", name: "助手", default: true }],
        },
      };

      const result = formatAgentList(cfg);

      expect(result).toContain("🤖 **可用专家助手**");
      expect(result).toContain("**助手** [默认]");
      expect(result).toContain("@main");
    });

    it("formats multiple agents", () => {
      const cfg = {
        agents: {
          list: [
            { id: "main", name: "助手", default: true },
            { id: "frontend", name: "前端专家" },
            { id: "backend", name: "后端专家" },
          ],
        },
      };

      const result = formatAgentList(cfg);

      expect(result).toContain("**助手** [默认]");
      expect(result).toContain("**前端专家**");
      expect(result).toContain("**后端专家**");
      expect(result).toContain("@frontend");
      expect(result).toContain("@backend");
    });

    it("uses id when name is not set", () => {
      const cfg = {
        agents: {
          list: [{ id: "bot" }],
        },
      };

      const result = formatAgentList(cfg);

      expect(result).toContain("**bot**");
    });

    it("includes usage instructions", () => {
      const cfg = {
        agents: {
          list: [{ id: "main", name: "助手", default: true }],
        },
      };

      const result = formatAgentList(cfg);

      expect(result).toContain("使用方法");
      expect(result).toContain("协作模式");
    });
  });
});