import { describe, expect, it } from "vitest";
import { buildDiscussionContext } from "../../src/discussion-context";

describe("buildDiscussionContext", () => {
  it("returns empty string when log is empty", () => {
    expect(buildDiscussionContext([])).toBe("");
  });

  it("formats single entry with agent name prefix", () => {
    const log = [{ agentName: "DBA", text: "发现慢查询" }];
    const result = buildDiscussionContext(log);
    expect(result).toContain("[DBA]: 发现慢查询");
    expect(result).toContain("--- 专家讨论记录 ---");
    expect(result).toContain("--- 讨论记录结束 ---");
  });

  it("formats multiple entries in order", () => {
    const log = [
      { agentName: "DBA", text: "发现慢查询" },
      { agentName: "网络专家", text: "连接池偏低" },
    ];
    const result = buildDiscussionContext(log);
    const dbaIdx = result.indexOf("[DBA]");
    const netIdx = result.indexOf("[网络专家]");
    expect(dbaIdx).toBeLessThan(netIdx);
  });

  it("truncates long text entries", () => {
    const longText = "x".repeat(1000);
    const log = [{ agentName: "DBA", text: longText }];
    const result = buildDiscussionContext(log, 100);
    expect(result).not.toContain("x".repeat(1000));
    expect(result).toContain("x".repeat(100));
  });
});
