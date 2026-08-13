import { z } from "zod";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const optionalNonemptyString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0
      ? undefined
      : value,
  z.string().trim().min(1).optional(),
);

const ApiEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().trim().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().max(65_535).default(4_000),
    DATABASE_URL: optionalNonemptyString,
    RELEASE_SHA: optionalNonemptyString,
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production") return;
    if (!environment.DATABASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "required",
      });
    }
    if (!environment.RELEASE_SHA) {
      context.addIssue({
        code: "custom",
        path: ["RELEASE_SHA"],
        message: "required",
      });
    }
  });

export type ApiConfig = Readonly<{
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl?: string;
  releaseSha: string;
}>;

export function parseApiConfig(environment: RuntimeEnvironment): ApiConfig {
  const result = ApiEnvironmentSchema.safeParse(environment);
  if (!result.success) throw new Error("API_CONFIG_INVALID");

  return {
    environment: result.data.NODE_ENV,
    host: result.data.HOST,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    releaseSha: result.data.RELEASE_SHA ?? "development",
  };
}
