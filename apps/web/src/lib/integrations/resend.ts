import { Resend } from "resend";
import { getRuntimeEnv } from "@/lib/config/env";
import type { NotificationAdapter } from "./contracts";

export class ResendNotificationAdapter implements NotificationAdapter {
  async send(input: { to: string; subject: string; html: string }) {
    const config = getRuntimeEnv().resend;
    if (!config) throw new Error("Resend is not configured. Emails are logged in demo mode.");
    const response = await new Resend(config.apiKey).emails.send({ from: config.fromEmail, ...input });
    if (response.error || !response.data) throw new Error(response.error?.message ?? "Resend did not return a message ID.");
    return { id: response.data.id };
  }
}
