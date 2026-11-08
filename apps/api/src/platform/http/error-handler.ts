import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors/app-error.js";

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const requestId = String(res.locals.requestId ?? "unknown");
  if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
    res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Uploaded content exceeds the configured size limit", requestId } });
    return;
  }
  if (error instanceof AppError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, requestId, ...(error.details ? { details: error.details } : {}) } });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON", requestId } });
    return;
  }
  console.error(JSON.stringify({ event: "unhandled_api_error", requestId, method: req.method, path: req.path, error: error instanceof Error ? error.message : "unknown" }));
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId } });
};
