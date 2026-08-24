import { MongoClient } from "mongodb";
import { getRuntimeEnv } from "@/lib/config/env";
import type { WebhookReceiptStore } from "./contracts";

let clientPromise: Promise<MongoClient> | undefined;

export async function getMongoDatabase() {
  const config = getRuntimeEnv().mongodb;
  if (!config) throw new Error("MongoDB is not configured. The application is running with demo data.");
  clientPromise ??= new MongoClient(config.uri).connect();
  const client = await clientPromise;
  return client.db(config.database);
}

export class MongoWebhookReceiptStore implements WebhookReceiptStore {
  async claim(input: { eventId: string; eventType: string; receivedAt: string }) {
    const database = await getMongoDatabase();
    const result = await database.collection("webhook_receipts").updateOne(
      { provider: "stripe", eventId: input.eventId },
      { $setOnInsert: { provider: "stripe", ...input } },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  }
}
