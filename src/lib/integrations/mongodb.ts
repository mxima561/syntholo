import { MongoClient } from "mongodb";
import { getRuntimeEnv } from "@/lib/config/env";

let clientPromise: Promise<MongoClient> | undefined;

export async function getMongoDatabase() {
  const config = getRuntimeEnv().mongodb;
  if (!config) throw new Error("MongoDB is not configured. The application is running with demo data.");
  clientPromise ??= new MongoClient(config.uri).connect();
  const client = await clientPromise;
  return client.db(config.database);
}
