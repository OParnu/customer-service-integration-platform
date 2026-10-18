import { createApp } from "../../../packages/shared/src/http.js";
import { mountA2aAgent } from "../../../packages/shared/src/agent-server.js";
import { logger } from "../../../packages/shared/src/logger.js";

const app = createApp();
app.get("/health/ready", (_req, res) => res.json({ status: "ready", service: "customer-agent" }));
const gatewayUrl = process.env.GATEWAY_URL ?? "http://kong:8000";
const internalApiKey = process.env.INTERNAL_API_KEY ?? "agent-internal-key";

mountA2aAgent(app, {
  id: "customer-agent",
  name: "Customer Agent",
  description: "Looks up customer records through the managed Customer API.",
  url: process.env.AGENT_URL ?? "http://localhost:3004/",
  skills: [{
    id: "get-customer",
    name: "Get customer",
    description: "Retrieve an existing customer by customer ID.",
    tags: ["customer", "lookup"],
    examples: ["Find customer C001", "Show customer C001"],
  }],
  async execute(payload, requestId) {
    const input = payload as { action?: string; customerId?: string };
    if (input?.action !== "get_customer" || !input.customerId) {
      return { ok: false, kind: "invalid_task", message: "A customerId is required." };
    }
    try {
      const response = await fetch(`${gatewayUrl}/api/v1/customers/${encodeURIComponent(input.customerId)}`, {
        headers: { apikey: internalApiKey, "x-correlation-id": requestId },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json() as { data?: unknown; error?: { message?: string } };
      if (response.status === 404) return { ok: false, kind: "not_found", message: body.error?.message ?? "Customer not found." };
      if (!response.ok) return { ok: false, kind: "unavailable", message: "Customer API is unavailable." };
      return { ok: true, customer: body.data };
    } catch {
      return { ok: false, kind: "unavailable", message: "Customer API is unavailable." };
    }
  },
});

const port = Number(process.env.PORT ?? 3004);
app.listen(port, () => logger.info({ port }, "customer agent listening"));

