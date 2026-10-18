import type { QueryResultRow } from "pg";
import { createPool } from "../../../packages/shared/src/db.js";
import { createApp, errorHandler, HttpError, requestId } from "../../../packages/shared/src/http.js";
import { logger } from "../../../packages/shared/src/logger.js";

interface Order extends QueryResultRow {
  id: string;
  customer_id: string;
  status: string;
  total: string;
  created_at: Date;
}

const app = createApp();
const pool = createPool();

app.get("/health/ready", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready", service: "order-api" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1/orders/:orderId", async (req, res) => {
  const orderId = req.params.orderId.toUpperCase();
  if (!/^O\d{3,10}$/.test(orderId)) {
    throw new HttpError(400, "INVALID_ORDER_ID", "orderId must look like O1001.");
  }

  const result = await pool.query<Order>(
    "SELECT id, customer_id, status, total, created_at FROM orders WHERE id = $1",
    [orderId],
  );
  const order = result.rows[0];
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", `Order ${orderId} was not found.`);

  res.json({ data: order, meta: { requestId: requestId(req) } });
});

app.get("/api/v1/orders", async (req, res) => {
  const customerId = typeof req.query.customerId === "string" ? req.query.customerId.toUpperCase() : "";
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
  const offset = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
  if (!/^C\d{3,10}$/.test(customerId)) {
    throw new HttpError(400, "INVALID_CUSTOMER_ID", "customerId is required and must look like C001.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new HttpError(400, "INVALID_LIMIT", "limit must be an integer between 1 and 50.");
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new HttpError(400, "INVALID_OFFSET", "offset must be an integer between 0 and 1000000.");
  }

  const result = await pool.query<Order>(
    "SELECT id, customer_id, status, total, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3",
    [customerId, limit, offset],
  );
  res.json({
    data: result.rows,
    meta: { count: result.rowCount, limit, offset, hasMore: result.rows.length === limit, requestId: requestId(req) },
  });
});

app.use((_req, _res, next) => next(new HttpError(404, "ROUTE_NOT_FOUND", "The requested route was not found.")));
app.use(errorHandler);

const port = Number(process.env.PORT ?? 3002);
const server = app.listen(port, () => logger.info({ port }, "order API listening"));
const shutdown = async () => {
  server.close();
  await pool.end();
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

