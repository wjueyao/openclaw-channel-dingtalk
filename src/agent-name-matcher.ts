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
 * @param atUserDingtalkIds - dingtalkIds from webhook atUsers field (real users selected via @picker)
 * @returns Matched agents, unmatched names, main agent ID, and whether there are invalid agent names
 *
 * @remarks
 * Exclusion logic for unmatched @mentions:
 * - If mention.userId is set (from richText or text.atUsers), it's a real user → excluded from unmatchedNames
 * - hasInvalidAgentNames is true when unmatchedNames.length > atUserDingtalkIds.length
 *   (meaning some @mentions are neither agents nor known real users)
 */
export function resolveAtAgents(
  atMentions: AtMention[],
  cfg: OpenClawConfig,
  atUserDingtalkIds?: string[],
): {
  matchedAgents: AgentNameMatch[];
  unmatchedNames: string[];
  mainAgentId: string;
  /** Count of @mentions that are likely real users (from atUserDingtalkIds) */
  realUserCount: number;
  /** Whether there are invalid agent names (unmatchedNames > realUserCount) */
  hasInvalidAgentNames: boolean;
} {
  const agents = cfg?.agents?.list as AgentConfig[] | undefined;
  const mainAgentId = getMainAgentId(agents);

  if (!atMentions || atMentions.length === 0) {
    return {
      matchedAgents: [],
      unmatchedNames: [],
      mainAgentId,
      realUserCount: 0,
      hasInvalidAgentNames: false,
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
      // Exclude @real users (those with userId are real users from richText or text.atUsers)
      if (!mention.userId) {
        unmatchedNames.push(mention.name);
      }
    }
  }

  // Count real users from atUserDingtalkIds
  // These are real DingTalk users selected via @picker, but we don't know which names they correspond to
  const realUserCount = atUserDingtalkIds?.length || 0;
  // If unmatchedNames.length > realUserCount, there are invalid agent names
  const hasInvalidAgentNames = unmatchedNames.length > realUserCount;

  return {
    matchedAgents,
    unmatchedNames,
    mainAgentId,
    realUserCount,
    hasInvalidAgentNames,
  };
}
