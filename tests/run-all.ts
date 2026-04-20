await import("./env.test.js");
await import("./risk-guards.test.js");
await import("./telegram-commands.test.js");
await import("./snapshot-service.test.js");
await import("./execution-service.test.js");
await import("./shared-config.test.js");
await import("./telegram-operator-contracts.test.js");
const { runRegisteredTests } = await import("./harness.js");
await runRegisteredTests();
