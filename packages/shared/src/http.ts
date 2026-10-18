import express, { type ErrorRequestHandler, type Express, type Request } from "express";
import { httpLogger } from "./logger.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function requestId(req: Request): string {
  const correlationId = req.header("x-correlation-id");
  if (correlationId && /^[A-Za-z0-9._:#-]{1,128}$/.test(correlationId)) return correlationId;
  const gatewayId = req.header("x-kong-request-id");
  return gatewayId || (req as Request & { id?: string }).id || "unknown";
}

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(httpLogger);
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  return app;
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const httpError = error instanceof HttpError ? error : undefined;
  const errorCode = typeof error?.code === "string" ? error.code : "";
  const parserError = typeof error?.type === "string" ? error.type : "";
  const timedOut = errorCode === "ETIMEDOUT" || errorCode === "ECONNABORTED";
  const unavailable = ["ECONNREFUSED", "ECONNRESET", "57P01", "57P03", "08000", "08001", "08003", "08004", "08006", "08007", "08P01"].includes(errorCode);
  const invalidJson = parserError === "entity.parse.failed";
  const oversizedBody = parserError === "entity.too.large";
  const status = httpError?.status ?? (timedOut ? 504 : unavailable ? 503 : invalidJson ? 400 : oversizedBody ? 413 : 500);
  const code = httpError?.code ?? (timedOut ? "DEPENDENCY_TIMEOUT" : unavailable ? "DEPENDENCY_UNAVAILABLE" : invalidJson ? "INVALID_JSON" : oversizedBody ? "REQUEST_TOO_LARGE" : "INTERNAL_ERROR");
  const message = httpError?.message ?? (timedOut
    ? "A downstream dependency timed out."
    : unavailable
      ? "A downstream dependency is unavailable."
      : invalidJson
        ? "Request body must contain valid JSON."
        : oversizedBody
          ? "Request body exceeds the 64 KB limit."
      : "An unexpected error occurred.");
  const id = requestId(req);

  req.log?.error({ err: error, requestId: id, status, code }, "request failed");
  res.status(status).json({ error: { code, message, requestId: id } });
};

