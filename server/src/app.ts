import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { corsMiddleware } from "./cors.js";
import { getLogger } from "./lib/logger.js";
import { requestContextMiddleware } from "./middleware/requestContext.js";
import healthRouter from "./routes/health.js";
import publisherRouter from "./routes/publishers.js";
import registryRouter from "./routes/registry.js";
import resourceRouter from "./routes/resources.js";
import verifyRouter from "./routes/verify.js";

export function createApp(): Express {
  const app = express();

  app.use(corsMiddleware());
  app.use(requestContextMiddleware);
  app.use(express.json());

  // Routes
  app.use(healthRouter);
  app.use(publisherRouter);
  app.use(registryRouter);
  app.use(resourceRouter);
  app.use(verifyRouter);

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    getLogger().error({ err, event: "unhandled_error" }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
