import type { Request, Response } from "express";
import { AgentCallError, delegateTask, discoverAgentForSkill, type AgentEndpoint } from "../../../packages/shared/src/a2a-client.js";
import { createApp, errorHandler, HttpError, requestId } from "../../../packages/shared/src/http.js";
import { logger } from "../../../packages/shared/src/logger.js";
import { buildQueryPlan, QueryPlanningError, type PlanStep, type QueryPlan } from "./planner.js";

type Customer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  created_at: string;
};

type Order = {
  id: string;
  customer_id: string;
  status: string;
  total: string;
  created_at: string;
};

type AgentTaskResult = {
  ok: boolean;
  kind?: string;
  message?: string;
  customer?: Customer;
  order?: Order;
  latestOrder?: Order | null;
  orders?: Order[];
};

type StepTrace = {
  capability: string;
  action: string;
  agent?: string;
  status: "planned" | "completed" | "not_found" | "failed";
};

const app = createApp();
app.get("/health/ready", (_req, res) => res.json({ status: "ready", service: "coordinator-agent" }));

const agentDirectory: AgentEndpoint[] = [
  { id: "customer-agent", url: process.env.CUSTOMER_AGENT_URL ?? "http://kong:8000/a2a/customer-agent/" },
  { id: "order-agent", url: process.env.ORDER_AGENT_URL ?? "http://kong:8000/a2a/order-agent/" },
];
const requestTimeoutMs = Number(process.env.COORDINATOR_TIMEOUT_MS ?? 25_000);

function reply(
  res: Response,
  req: Request,
  plan: QueryPlan,
  trace: StepTrace[],
  body: Record<string, unknown>,
  status = 200,
): void {
  res.status(status).json({
    ...body,
    meta: {
      requestId: requestId(req),
      intent: plan.intent,
      plan: { steps: trace },
    },
  });
}

function asAgentCallError(error: unknown, signal: AbortSignal): AgentCallError {
  if (error instanceof AgentCallError) return error;
  const name = error instanceof Error ? error.name : "";
  if (signal.aborted || name === "TimeoutError" || name === "AbortError") {
    return new AgentCallError(504, "AGENT_TIMEOUT", "The delegated task timed out.");
  }
  return new AgentCallError(503, "AGENT_UNAVAILABLE", "The requested capability is temporarily unavailable.");
}

function resultFrom(value: unknown): AgentTaskResult {
  if (value && typeof value === "object" && typeof (value as AgentTaskResult).ok === "boolean") {
    return value as AgentTaskResult;
  }
  throw new AgentCallError(503, "INVALID_AGENT_RESPONSE", "The Agent returned an invalid response.");
}

async function executeStep(
  step: PlanStep,
  plan: QueryPlan,
  id: string,
  signal: AbortSignal,
  trace: StepTrace[],
): Promise<AgentTaskResult> {
  const stepTrace: StepTrace = { capability: step.skillId, action: step.action, status: "planned" };
  trace.push(stepTrace);
  try {
    const agent = await discoverAgentForSkill(agentDirectory, step.skillId, id, signal);
    stepTrace.agent = agent.id;
    logger.info({ requestId: id, intent: plan.intent, capability: step.skillId, action: step.action, selectedAgent: agent.id }, "coordinator capability selected");

    const result = resultFrom(await delegateTask<unknown>(
      agent,
      { action: step.action, ...step.input },
      id,
      signal,
    ));
    if (result.ok) {
      stepTrace.status = "completed";
      logger.info({ requestId: id, intent: plan.intent, capability: step.skillId, selectedAgent: agent.id, outcome: "completed" }, "coordinator plan step completed");
      return result;
    }
    if (result.kind === "not_found") {
      stepTrace.status = "not_found";
      return result;
    }
    throw new AgentCallError(503, "AGENT_UNAVAILABLE", result.message ?? "The requested capability is temporarily unavailable.");
  } catch (error) {
    const failure = asAgentCallError(error, signal);
    stepTrace.status = "failed";
    logger.warn({ requestId: id, intent: plan.intent, capability: step.skillId, selectedAgent: stepTrace.agent, code: failure.code, status: failure.status }, "coordinator plan step failed");
    throw failure;
  }
}

function completedResult(results: Map<string, AgentTaskResult>, key: PlanStep["resultKey"]): AgentTaskResult | undefined {
  return results.get(key);
}

function partialFailureResponse(
  res: Response,
  req: Request,
  plan: QueryPlan,
  trace: StepTrace[],
  results: Map<string, AgentTaskResult>,
  failedStep: PlanStep,
  failure: AgentCallError,
): void {
  const customer = completedResult(results, "customer")?.customer;
  const label = failedStep.skillId === "get-latest-order"
    ? "latest order"
    : failedStep.skillId === "get-all-orders"
      ? "orders"
      : "order";
  const answer = customer
    ? `Found customer ${customer.name} (${customer.id}), but could not retrieve the requested ${label} right now.`
    : `Could not retrieve the requested ${label} right now.`;

  logger.warn({
    requestId: requestId(req),
    intent: plan.intent,
    outcome: "partial",
    completedCapabilities: trace.filter((step) => step.status === "completed").map((step) => step.capability),
    failedCapability: failedStep.skillId,
    errorCode: failure.code,
  }, "coordinator returning partial result");

  reply(res, req, plan, trace, {
    status: "partial",
    answer,
    ...(customer ? { customer } : {}),
    issues: [{ capability: failedStep.skillId, code: failure.code, message: failure.message }],
  });
}

function notFoundResponse(
  res: Response,
  req: Request,
  plan: QueryPlan,
  trace: StepTrace[],
  step: PlanStep,
  result: AgentTaskResult,
  results: Map<string, AgentTaskResult>,
): void {
  const answer = result.message ?? "The requested record was not found.";
  if (step.resultKey === "order" && plan.customerId && completedResult(results, "customer")?.customer) {
    const customer = completedResult(results, "customer")?.customer;
    reply(res, req, plan, trace, {
      status: "partial",
      answer,
      ...(customer ? { customer } : {}),
      order: null,
      issues: [{ capability: step.skillId, code: "ORDER_NOT_FOUND", message: answer }],
    });
    return;
  }
  const idField = step.resultKey === "customer" ? { customerId: plan.customerId } : { orderId: plan.orderId };
  reply(res, req, plan, trace, { status: "not_found", answer, message: answer, ...idField }, 404);
}

function successfulResponse(
  res: Response,
  req: Request,
  plan: QueryPlan,
  trace: StepTrace[],
  results: Map<string, AgentTaskResult>,
): void {
  const customer = completedResult(results, "customer")?.customer;
  const order = completedResult(results, "order")?.order;
  const latestOrder = completedResult(results, "latestOrder")?.latestOrder ?? null;
  const orders = completedResult(results, "orders")?.orders ?? [];

  if (plan.intent === "customer_lookup" && customer) {
    reply(res, req, plan, trace, {
      status: "ok",
      answer: `Found customer ${customer.name} (${customer.id}).`,
      customer,
    });
    return;
  }

  if (plan.intent === "order_lookup" && order) {
    reply(res, req, plan, trace, {
      status: "ok",
      answer: `Order ${order.id} status is ${order.status}.`,
      order,
    });
    return;
  }

  if (plan.customerId && plan.orderId && customer && order) {
    if (order.customer_id !== plan.customerId) {
      const answer = `Order ${order.id} does not belong to customer ${plan.customerId}.`;
      reply(res, req, plan, trace, {
        status: "not_found",
        answer,
        message: answer,
        customerId: plan.customerId,
        orderId: plan.orderId,
      }, 404);
      return;
    }
    reply(res, req, plan, trace, {
      status: "ok",
      answer: `Found customer ${customer.name} and order ${order.id} is ${order.status}.`,
      customer,
      order,
    });
    return;
  }

  if (customer && plan.steps.some((step) => step.resultKey === "orders")) {
    reply(res, req, plan, trace, {
      status: "ok",
      answer: orders.length === 0 ? `No orders were found for customer ${customer.id}.` : `Found ${orders.length} orders for customer ${customer.id}.`,
      customer,
      orders,
      ...(orders.length === 0 ? { message: "No orders were found for this customer." } : {}),
    });
    return;
  }

  if (customer && plan.steps.some((step) => step.resultKey === "latestOrder")) {
    reply(res, req, plan, trace, {
      status: "ok",
      answer: latestOrder
        ? `Latest order ${latestOrder.id} for ${customer.name} is ${latestOrder.status}.`
        : `No orders were found for customer ${customer.id}.`,
      customer,
      latestOrder,
      ...(!latestOrder ? { message: "No orders were found for this customer." } : {}),
    });
    return;
  }

  throw new HttpError(503, "AGENT_UNAVAILABLE", "The requested capability did not return the expected data.");
}

app.post("/api/v1/agent/query", async (req, res) => {
  let plan: QueryPlan;
  try {
    plan = buildQueryPlan(req.body?.query);
  } catch (error) {
    if (error instanceof QueryPlanningError) throw new HttpError(400, error.code, error.message);
    throw error;
  }

  const id = requestId(req);
  const trace: StepTrace[] = [];
  const results = new Map<string, AgentTaskResult>();
  const deadline = AbortSignal.timeout(requestTimeoutMs);
  logger.info({
    requestId: id,
    intent: plan.intent,
    plan: plan.steps.map(({ skillId, action }) => ({ capability: skillId, action })),
  }, "coordinator plan created");

  for (const step of plan.steps) {
    let result: AgentTaskResult;
    try {
      result = await executeStep(step, plan, id, deadline, trace);
    } catch (error) {
      const failure = asAgentCallError(error, deadline);
      if (results.size > 0) {
        partialFailureResponse(res, req, plan, trace, results, step, failure);
        return;
      }
      throw new HttpError(failure.status, failure.code, failure.message);
    }

    if (!result.ok) {
      if (step.resultKey === "customer" || step.resultKey === "order") {
        notFoundResponse(res, req, plan, trace, step, result, results);
        return;
      }
      throw new HttpError(503, "AGENT_UNAVAILABLE", result.message ?? "The Agent could not complete the task.");
    }
    results.set(step.resultKey, result);
  }

  successfulResponse(res, req, plan, trace, results);
});

app.use((_req, _res, next) => next(new HttpError(404, "ROUTE_NOT_FOUND", "The requested route was not found.")));
app.use(errorHandler);

const port = Number(process.env.PORT ?? 3003);
const server = app.listen(port, () => logger.info({ port }, "coordinator agent listening"));
const shutdown = () => server.close();
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
