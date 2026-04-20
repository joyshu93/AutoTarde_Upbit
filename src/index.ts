import { createApp } from "./app/create-app.js";

function main(): void {
  const app = createApp();

  const banner = {
    service: app.config.serviceName,
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    upbitBaseUrl: app.config.upbitBaseUrl,
    databasePath: app.config.databasePath,
    supportedCommands: app.telegramRouter.getSupportedCommands(),
  };

  console.log(JSON.stringify(banner, null, 2));
}

main();
