import { randomUUID } from "node:crypto";
import { TaskState } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { Express } from "express";
import { logger } from "./logger.js";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  url: string;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
  }>;
  execute(payload: unknown, requestId: string): Promise<unknown>;
}

function textFromMessage(message: any): string {
  return (message?.parts ?? [])
    .map((part: any) => {
      if (part?.content?.$case === "text" && typeof part.content.value === "string") return part.content.value;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.data?.text === "string") return part.data.text;
      return "";
    })
    .join("");
}

function payloadFromMessage(message: any): { payload: unknown; requestId: string } {
  const raw = textFromMessage(message);
  try {
    const parsed = JSON.parse(raw) as { payload?: unknown; requestId?: string };
    return {
      payload: parsed.payload,
      requestId: parsed.requestId ?? "unknown",
    };
  } catch {
    return { payload: raw, requestId: "unknown" };
  }
}

export function mountA2aAgent(app: Express, definition: AgentDefinition): void {
  const card = {
    name: definition.name,
    description: definition.description,
    version: "1.0.0",
    supportedInterfaces: [{
      url: definition.url,
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
    }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: definition.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      examples: skill.examples ?? [],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    })),
  };

  const executor = {
    async execute(context: any, eventBus: any) {
      const taskId = context.taskId;
      const contextId = context.contextId;
      const { payload, requestId: id } = payloadFromMessage(context.userMessage);
      const previousTask = context.task;
      const history = previousTask?.history ?? [];
      const task = previousTask
        ? {
            ...previousTask,
            history: history.some((message: any) => message.messageId === context.userMessage.messageId)
              ? history
              : [...history, context.userMessage],
          }
        : {
            id: taskId,
            contextId,
            status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
            artifacts: [],
            history: [context.userMessage],
            metadata: undefined,
          };
      eventBus.publish(AgentEvent.task(task));
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
        metadata: undefined,
      }));

      let output: unknown;
      try {
        output = await definition.execute(payload, id);
      } catch (error) {
        logger.error({ err: error, requestId: id, agent: definition.id }, "agent task failed");
        output = { ok: false, kind: "unavailable", message: "The delegated capability is unavailable." };
      }

      eventBus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: randomUUID(),
          name: "result",
          description: "Deterministic agent task result",
          parts: [{
            content: { $case: "text", value: JSON.stringify(output) },
            metadata: undefined,
            filename: "",
            mediaType: "text/plain",
          }],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }));
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
        metadata: undefined,
      }));
      logger.info({ requestId: id, agent: definition.id, taskId }, "agent task completed");
    },
  };

  const requestHandler = new DefaultRequestHandler(card as any, new InMemoryTaskStore(), executor as any);
  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
}

