import type { NtfyConfig } from "../config.ts";
import type { AlertMessage, Notifier } from "../ports.ts";

export function createNtfyNotifier(config: NtfyConfig): Notifier {
  return {
    async send(message: AlertMessage): Promise<void> {
      const payload = {
        topic: config.topic,
        title: message.title,
        message: message.body,
        priority: message.priority ?? "high",
        tags: message.tags ?? ["fuel"],
      };

      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (config.token) headers.authorization = `Bearer ${config.token}`;

      const response = await fetch(config.server, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`ntfy publish failed with status ${response.status}`);
      }
    },
  };
}
