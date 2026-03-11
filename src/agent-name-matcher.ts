/**
 * Agent name matcher for @sub-agent feature
 *
 * Matches @mentions to agent IDs based on name and id fields in agents.list config.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { AtMention, AgentNameMatch } from "./types";

interface AgentConfig {
  id: string;
  name?: string;
  default?: boolean;
}

/**
 * Normalize name for case-insensitive matching
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Get main agent ID from agents.list
 */
export function getMainAgentId(agents: AgentConfig[] | undefined): string {
  if (!agents || agents.length === 0) {
    return "main";
  }

  const defaultAgent = agents.find((a) => a.default);
  if (defaultAgent) {
    return defaultAgent.id;
  }

  return agents[0].id;
}

/**
 * Match a single @name to an agent
 */
function matchAtName(atName: string, agents: AgentConfig[]): AgentNameMatch | null {
  const normalizedAtName = normalizeName(atName);

  for (const agent of agents) {
    // 1. Match by name field
    if (agent.name && normalizeName(agent.name) === normalizedAtName) {
      return {
        agentId: agent.id,
        matchSource: "name",
        matchedName: agent.name,
      };
    }

    // 2. Match by id field
    if (normalizeName(agent.id) === normalizedAtName) {
      return {
        agentId: agent.id,
        matchSource: "id",
        matchedName: agent.id,
      };
    }
  }

  return null;
}

/**
 * Resolve @mentions to agent matches
 *
 * @param atMentions - List of @mentions extracted from message
 * @param cfg - OpenClaw configuration
 * @returns Matched agents, unmatched names, and main agent ID
 */
export function resolveAtAgents(
  atMentions: AtMention[],
  cfg: OpenClawConfig,
): {
  matchedAgents: AgentNameMatch[];
  unmatchedNames: string[];
  mainAgentId: string;
} {
  const agents = cfg?.agents?.list as AgentConfig[] | undefined;
  const mainAgentId = getMainAgentId(agents);

  if (!atMentions || atMentions.length === 0) {
    return {
      matchedAgents: [],
      unmatchedNames: [],
      mainAgentId,
    };
  }

  const matchedAgents: AgentNameMatch[] = [];
  const unmatchedNames: string[] = [];

  for (const mention of atMentions) {
    const match = agents ? matchAtName(mention.name, agents) : null;

    if (match) {
      // Avoid duplicate agents
      if (!matchedAgents.some((m) => m.agentId === match.agentId)) {
        matchedAgents.push(match);
      }
    } else {
      // Exclude @real users (those with userId are real users)
      if (!mention.userId) {
        unmatchedNames.push(mention.name);
      }
    }
  }

  return {
    matchedAgents,
    unmatchedNames,
    mainAgentId,
  };
}

/**
 * Extract agent IDs mentioned in a reply text
 *
 * Used to detect when an agent @mentions another agent in their reply,
 * enabling agent-to-agent collaboration.
 *
 * @param text - The reply text to scan for @mentions
 * @param cfg - OpenClaw configuration
 * @param excludeAgentIds - Agent IDs to exclude (e.g., the sender itself)
 * @returns Array of matched agent IDs
 */
export function extractAgentMentionsFromText(
  text: string,
  cfg: OpenClawConfig,
  excludeAgentIds: string[] = [],
): string[] {
  const agents = cfg?.agents?.list as AgentConfig[] | undefined;
  if (!agents || agents.length === 0 || !text) {
    return [];
  }

  const mentionedAgentIds: string[] = [];

  // Pattern: @name or @Name (word boundary after @)
  const mentionPattern = /@([^\s@]+)/g;
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const mentionName = match[1].trim();
    const agentMatch = matchAtName(mentionName, agents);

    if (agentMatch && !excludeAgentIds.includes(agentMatch.agentId)) {
      if (!mentionedAgentIds.includes(agentMatch.agentId)) {
        mentionedAgentIds.push(agentMatch.agentId);
      }
    }
  }

  return mentionedAgentIds;
}

/**
 * Format agent list for display
 *
 * Returns a formatted string listing all available agents.
 * Used for /agents command.
 *
 * @param cfg - OpenClaw configuration
 * @returns Formatted agent list string
 */
export function formatAgentList(cfg: OpenClawConfig): string {
  const agents = cfg?.agents?.list as AgentConfig[] | undefined;
  const mainAgentId = getMainAgentId(agents);

  if (!agents || agents.length === 0) {
    return "当前没有配置专家助手。";
  }

  const lines: string[] = ["🤖 **可用专家助手**\n"];

  for (const agent of agents) {
    const isMain = agent.id === mainAgentId;
    const displayName = agent.name || agent.id;
    const badge = isMain ? " [默认]" : "";
    const mentionHint = `@${agent.id}`;
    lines.push(`• **${displayName}**${badge} - 使用 \`${mentionHint}\` 唤起`);
  }

  lines.push("\n💡 **使用方法**：在消息中 `@专家名` 即可让对应专家回复");
  lines.push("📝 **协作模式**：专家之间可以相互 @ 协作讨论");

  return lines.join("\n");
}
