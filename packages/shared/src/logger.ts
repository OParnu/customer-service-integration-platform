import { pino } from "pino";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import type { Request } from "express";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "partilon-service" },
  redact: ["req.headers.apikey", "req.headers.authorization"],
});

export const httpLogger = pinoHttp({
  logger,
  genReqId(req: Request) {
    const correlationId = req.header("x-correlation-id");
    if (correlationId && /^[A-Za-z0-9._:#-]{1,128}$/.test(correlationId)) return correlationId;
    const gatewayId = req.header("x-kong-request-id");
    return gatewayId || req.header("x-request-id") || randomUUID();
  },
  customProps(req) {
    return { requestId: (req as Request & { id?: string }).id };
  },
  autoLogging: {
    ignore: (req) => req.url === "/health/live" || req.url === "/health/ready",
  },
});

