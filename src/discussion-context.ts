/**
 * Build discussion context string from accumulated discussion log.
 * Injected into each expert's inbound context so they can see what
 * other experts have said in previous collaboration rounds.
 */
export function buildDiscussionContext(
  discussionLog: Array<{ agentName: string; text: string }>,
  maxCharsPerEntry: number = 500,
): string {
  if (discussionLog.length === 0) {
    return "";
  }

  let context = "\n\n--- 专家讨论记录 ---\n";
  for (const entry of discussionLog) {
    const truncated = entry.text.slice(0, maxCharsPerEntry);
    context += `[${entry.agentName}]: ${truncated}\n`;
  }
  context += "--- 讨论记录结束 ---\n\n";
  return context;
}
