import { runWatcher } from "./composition.ts";

function parseConfigPath(args: readonly string[]): string {
  const flagIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
  if (flagIndex !== -1 && args[flagIndex + 1]) {
    return args[flagIndex + 1];
  }
  return args.find((arg) => !arg.startsWith("-")) ?? "config.json";
}

if (import.meta.main) {
  const configPath = parseConfigPath(Deno.args);
  runWatcher(configPath).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
