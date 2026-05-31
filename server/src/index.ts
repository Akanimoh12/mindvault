import { config } from "./config.js";
import { createApp } from "./app.js";
import { rootLogger } from "./lib/logger.js";

const app = createApp();

app.listen(config.PORT, () => {
  rootLogger.info(
    {
      event: "server_start",
      port: config.PORT,
      network: config.NETWORK,
      healthUrl: `http://localhost:${config.PORT}/health`,
    },
    "MindVault server started",
  );
});
