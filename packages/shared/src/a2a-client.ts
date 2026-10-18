import { randomUUID } from "node:crypto";
import { Role, type AgentCard } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
} from "@a2a-js/sdk/client";

const a2aGatewayKey = process.env.A2A_GATEWAY_KEY ?? "coordinator-a2a-key";
const agentCardCacheTtlMs = 5 * 60_000;
const agentCardCache = new Map<string, { expiresAt: number; card: AgentCard }>();
const parsedAgentCallTimeoutMs = Number(process.env.AGENT_CALL_TIMEOUT_MS ?? 10_000);
const agentCallTimeoutMs = Number.isFinite(parsedAgentCallTimeoutMs) && parsedAgentCallTimeoutMs > 0
  ? parsedAgentCallTimeoutMs
  : 10_000;

export interface AgentEndpoint {
  id: string;
  url: string;
}

export interface DiscoveredAgent {
  id: string;
  url: string;
  card: AgentCard;
  skillId: string;
}

export class AgentCallError extends Error {
  constructor(
    public readonly status: 503 | 504,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentCallError";
  }
}

function combinedSignal(requestSignal?: AbortSignal, sdkSignal?: AbortSignal | null): AbortSignal {
  const signals = [requestSignal, sdkSignal, AbortSignal.timeout(agentCallTimeoutMs)].filter(
    (signal): signal is AbortSignal => signal != null,
  );
  return AbortSignal.any(signals);
}

function resolverFor(requestId: string, requestSignal?: AbortSignal): DefaultAgentCardResolver {
  return new DefaultAgentCardResolver({
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("apikey", a2aGatewayKey);
      headers.set("X-Correlation-ID", requestId);
      return fetch(input, {
        ...init,
        headers,
        signal: combinedSignal(requestSignal, init?.signal),
      });
    },
  });
}

function agentCardPath(agentUrl: string): string {
  const basePath = new URL(agentUrl).pathname.replace(/\/$/, "");
  return `${basePath}/.well-known/agent-card.json`;
}

async function resolveAgentCard(
  candidate: AgentEndpoint,
  resolver: DefaultAgentCardResolver,
): Promise<AgentCard> {
  const cached = agentCardCache.get(candidate.url);
  if (cached && cached.expiresAt > Date.now()) return cached.card;

  const card = await resolver.resolve(candidate.url, agentCardPath(candidate.url));
  agentCardCache.set(candidate.url, { card, expiresAt: Date.now() + agentCardCacheTtlMs });
  return card;
}

export async function discoverAgentForSkill(
  candidates: AgentEndpoint[],
  skillId: string,
  requestId: string,
  requestSignal?: AbortSignal,
): Promise<DiscoveredAgent> {
  const resolver = resolverFor(requestId, requestSignal);
  const discovered = await Promise.allSettled(candidates.map(async (candidate) => ({
    candidate,
    card: await resolveAgentCard(candidate, resolver),
  })));
  const matches = discovered.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    const skill = result.value.card.skills?.find((entry) => entry.id === skillId);
    return skill ? [{ ...result.value, skillId: skill.id }] : [];
  });
  if (matches[0]) {
    return { id: matches[0].candidate.id, url: matches[0].candidate.url, card: matches[0].card, skillId: matches[0].skillId };
  }

  const failures = discovered.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (requestSignal?.aborted || failures.some((failure) => failure.reason instanceof Error && ["TimeoutError", "AbortError"].includes(failure.reason.name))) {
    throw new AgentCallError(504, "AGENT_TIMEOUT", "Agent discovery timed out.");
  }
  if (failures.length > 0) {
    throw new AgentCallError(503, "AGENT_UNAVAILABLE", "No available Agent advertises the requested capability.");
  }
  throw new AgentCallError(503, "CAPABILITY_UNAVAILABLE", `No Agent advertises capability '${skillId}'.`);
}

export async function delegateTask<T>(
  agent: DiscoveredAgent,
  payload: unknown,
  requestId: string,
  requestSignal?: AbortSignal,
): Promise<T> {
  const cardResolver = resolverFor(requestId, requestSignal);
  const factoryOptions = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    cardResolver,
  });
  const clientFactory = new ClientFactory(factoryOptions);
  const client: any = await clientFactory.createFromAgentCard(agent.card);
  const result = await client.sendMessage({
    message: {
      messageId: randomUUID(),
        role: Role.ROLE_USER,
        parts: [{
          content: { $case: "text", value: JSON.stringify({ payload, requestId }) },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        }],
    },
  }, {
    signal: combinedSignal(requestSignal),
    serviceParameters: {
      apikey: a2aGatewayKey,
      "X-Correlation-ID": requestId,
    },
  });

  const parts = [
    ...(result?.parts ?? []),
    ...(result?.artifacts ?? []).flatMap((artifact: any) => artifact.parts ?? []),
  ];
  const text = parts.map((part: any) => {
    if (part?.content?.$case === "text" && typeof part.content.value === "string") return part.content.value;
    return typeof part?.text === "string" ? part.text : undefined;
  }).find((value: unknown) => typeof value === "string");
  if (typeof text !== "string") throw new Error("A2A agent returned no text artifact");
  return JSON.parse(text) as T;
}

