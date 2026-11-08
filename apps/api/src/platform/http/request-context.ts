import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header("x-request-id");
  const requestId = supplied && /^[a-zA-Z0-9._-]{1,80}$/.test(supplied) ? supplied : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}
