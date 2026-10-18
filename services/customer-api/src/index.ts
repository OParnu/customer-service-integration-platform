import type { QueryResultRow } from "pg";
import { createPool } from "../../../packages/shared/src/db.js";
import { createApp, errorHandler, HttpError, requestId } from "../../../packages/shared/src/http.js";
import { logger } from "../../../packages/shared/src/logger.js";

interface Customer extends QueryResultRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  created_at: Date;
}

const app = createApp();
const pool = createPool();

app.get("/health/ready", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready", service: "customer-api" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1/customers/:customerId", async (req, res) => {
  const customerId = req.params.customerId.toUpperCase();
  if (!/^C\d{3,10}$/.test(customerId)) {
    throw new HttpError(400, "INVALID_CUSTOMER_ID", "customerId must look like C001.");
  }

  const result = await pool.query<Customer>(
    "SELECT id, name, email, phone, created_at FROM customers WHERE id = $1",
    [customerId],
  );
  const customer = result.rows[0];
  if (!customer) throw new HttpError(404, "CUSTOMER_NOT_FOUND", `Customer ${customerId} was not found.`);

  res.json({ data: customer, meta: { requestId: requestId(req) } });
});

app.use((_req, _res, next) => next(new HttpError(404, "ROUTE_NOT_FOUND", "The requested route was not found.")));
app.use(errorHandler);

const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, () => logger.info({ port }, "customer API listening"));
const shutdown = async () => {
  server.close();
  await pool.end();
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

