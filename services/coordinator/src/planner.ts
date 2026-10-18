export type AgentSkillId =
  | "get-customer"
  | "get-order-by-id"
  | "get-latest-order"
  | "get-all-orders";

export type PlanStep = {
  skillId: AgentSkillId;
  action: "get_customer" | "get_order" | "latest_order" | "all_orders";
  resultKey: "customer" | "order" | "latestOrder" | "orders";
  input: { customerId?: string; orderId?: string };
};

export type QueryPlan = {
  intent: "customer_lookup" | "order_lookup" | "customer_order_lookup";
  customerId?: string;
  orderId?: string;
  steps: PlanStep[];
};

export class QueryPlanningError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QueryPlanningError";
  }
}

function uniqueMatches(query: string, pattern: RegExp): string[] {
  return [...new Set(Array.from(query.matchAll(pattern), (match) => match[0].toUpperCase()))];
}

export function buildQueryPlan(input: unknown): QueryPlan {
  if (typeof input !== "string" || input.trim().length === 0 || input.length > 1000) {
    throw new QueryPlanningError("INVALID_QUERY", "query must be a non-empty string of at most 1000 characters.");
  }

  const query = input.trim();
  const customerIds = uniqueMatches(query, /\bC\d{3,10}\b/gi);
  const orderIds = uniqueMatches(query, /\bO\d{3,10}\b/gi);
  if (customerIds.length > 1 || orderIds.length > 1) {
    throw new QueryPlanningError("AMBIGUOUS_QUERY", "Ask about one customer and one order at a time.");
  }

  const customerId = customerIds[0];
  const orderId = orderIds[0];
  const mentionsOrder = /\border(?:s)?\b|\bpurchase(?:s)?\b|\u0e2d\u0e2d\u0e40\u0e14\u0e2d\u0e23\u0e4c|\u0e04\u0e33\u0e2a\u0e31\u0e48\u0e07\u0e0b\u0e37\u0e49\u0e2d/i.test(query);
  const asksForLatest = /\b(latest|last|most recent|newest|recent)\b|\border status\b|\u0e25\u0e48\u0e32\u0e2a\u0e38\u0e14/i.test(query);
  const asksForAll = mentionsOrder && (
    /\b(all|every|each)\b|\border history\b|\u0e17\u0e31\u0e49\u0e07\u0e2b\u0e21\u0e14|\u0e17\u0e38\u0e01/i.test(query)
    || (/\borders\b/i.test(query) && !asksForLatest)
  );

  if (!customerId && !orderId) {
    throw new QueryPlanningError("UNSUPPORTED_QUERY", "Include a customer ID such as C001 or an order ID such as O1001.");
  }
  if (asksForAll && asksForLatest) {
    throw new QueryPlanningError("AMBIGUOUS_ORDER_SCOPE", "Specify whether you want the latest order or all orders.");
  }

  if (customerId && orderId) {
    return {
      intent: "customer_order_lookup",
      customerId,
      orderId,
      steps: [
        { skillId: "get-customer", action: "get_customer", resultKey: "customer", input: { customerId } },
        { skillId: "get-order-by-id", action: "get_order", resultKey: "order", input: { orderId } },
      ],
    };
  }

  if (orderId) {
    return {
      intent: "order_lookup",
      orderId,
      steps: [{ skillId: "get-order-by-id", action: "get_order", resultKey: "order", input: { orderId } }],
    };
  }

  if (mentionsOrder) {
    const getAll = asksForAll;
    return {
      intent: "customer_order_lookup",
      customerId,
      steps: [
        { skillId: "get-customer", action: "get_customer", resultKey: "customer", input: { customerId } },
        getAll
          ? { skillId: "get-all-orders", action: "all_orders", resultKey: "orders", input: { customerId } }
          : { skillId: "get-latest-order", action: "latest_order", resultKey: "latestOrder", input: { customerId } },
      ],
    };
  }

  return {
    intent: "customer_lookup",
    customerId,
    steps: [{ skillId: "get-customer", action: "get_customer", resultKey: "customer", input: { customerId } }],
  };
}
