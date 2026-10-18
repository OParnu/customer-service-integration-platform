import { createApp } from "../../../packages/shared/src/http.js";
import { mountA2aAgent } from "../../../packages/shared/src/agent-server.js";
import { logger } from "../../../packages/shared/src/logger.js";

const app = createApp();
app.get("/health/ready", (_req, res) => res.json({ status: "ready", service: "order-agent" }));
const gatewayUrl = process.env.GATEWAY_URL ?? "http://kong:8000";
const internalApiKey = process.env.INTERNAL_API_KEY ?? "agent-internal-key";

mountA2aAgent(app, {
  id: "order-agent",
  name: "Order Agent",
  description: "Looks up order records through the managed Order API.",
  url: process.env.AGENT_URL ?? "http://localhost:3005/",
  skills: [
    {
      id: "get-order-by-id",
      name: "Get order by ID",
      description: "Retrieve one order by its order ID, including its status.",
      tags: ["order", "lookup", "status"],
      examples: ["Find order O1001", "Show status of O1001"],
    },
    {
      id: "get-latest-order",
      name: "Get latest customer order",
      description: "Retrieve the newest order for a customer.",
      tags: ["order", "latest", "recent", "status"],
      examples: ["Get the latest order for C001", "What is C001's latest order status?"],
    },
    {
      id: "get-all-orders",
      name: "Get all customer orders",
      description: "Retrieve all orders for a customer, using pagination when needed.",
      tags: ["orders", "history", "all-orders"],
      examples: ["Show all orders for C001", "Get order history for C001"],
    },
  ],
  async execute(payload, requestId) {
    const input = payload as { action?: string; orderId?: string; customerId?: string };
    if (input?.action === "get_order" && input.orderId) {
      try {
        const response = await fetch(`${gatewayUrl}/api/v1/orders/${encodeURIComponent(input.orderId)}`, {
          headers: { apikey: internalApiKey, "x-correlation-id": requestId },
          signal: AbortSignal.timeout(5_000),
        });
        const body = await response.json() as { data?: unknown; error?: { message?: string } };
        if (response.status === 404) return { ok: false, kind: "not_found", message: body.error?.message ?? "Order not found." };
        if (!response.ok) return { ok: false, kind: "unavailable", message: "Order API is unavailable." };
        return { ok: true, order: body.data };
      } catch {
        return { ok: false, kind: "unavailable", message: "Order API is unavailable." };
      }
    }

    if ((input?.action !== "latest_order" && input?.action !== "all_orders") || !input.customerId) {
      return { ok: false, kind: "invalid_task", message: "Provide an orderId, or a customerId with latest_order or all_orders." };
    }

    const pageSize = input.action === "latest_order" ? 1 : 50;
    const orders: unknown[] = [];
    let offset = 0;
    try {
      while (true) {
        const path = `/api/v1/orders?customerId=${encodeURIComponent(input.customerId)}&limit=${pageSize}&offset=${offset}`;
        const response = await fetch(`${gatewayUrl}${path}`, {
          headers: { apikey: internalApiKey, "x-correlation-id": requestId },
          signal: AbortSignal.timeout(5_000),
        });
        const body = await response.json() as {
          data?: unknown[];
          meta?: { hasMore?: boolean };
          error?: { message?: string };
        };
        if (!response.ok) {
          return { ok: false, kind: "unavailable", message: body.error?.message ?? "Order API is unavailable." };
        }
        if (!Array.isArray(body.data)) {
          return { ok: false, kind: "unavailable", message: "Order API returned an invalid response." };
        }

        const page = body.data;
        orders.push(...page);
        if (input.action === "latest_order") {
          return { ok: true, latestOrder: orders[0] ?? null };
        }
        if (body.meta?.hasMore !== true) break;
        offset += page.length;
      }
      return { ok: true, orders };
    } catch {
      return { ok: false, kind: "unavailable", message: "Order API is unavailable." };
    }
  },
});

const port = Number(process.env.PORT ?? 3005);
app.listen(port, () => logger.info({ port }, "order agent listening"));

