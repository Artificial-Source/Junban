import { z } from "zod";

const PROFILE_DEFAULTS = {
  daily: {
    DB_PATH: "./data/junban.db",
    MARKDOWN_PATH: "./tasks/",
  },
  dev: {
    DB_PATH: "./data/dev/junban.db",
    MARKDOWN_PATH: "./tasks/dev/",
  },
} as const;

const profileSchema = z.enum(["daily", "dev"]);

const pathSchema = z
  .string()
  .trim()
  .min(1, "Path must not be empty")
  .refine((value) => !value.includes("\0"), "Path must not contain null bytes");

const envSchema = z.object({
  JUNBAN_PROFILE: profileSchema.default("daily"),
  DB_PATH: pathSchema,
  STORAGE_MODE: z.enum(["sqlite", "markdown"]).default("sqlite"),
  MARKDOWN_PATH: pathSchema,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PORT: z.coerce.number().default(5173),
  DEFAULT_THEME: z.enum(["light", "dark"]).default("light"),
  NLP_LOCALE: z.string().default("en"),
  PLUGIN_DIR: pathSchema.default("./plugins/"),
  PLUGIN_SANDBOX: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  PLUGIN_REGISTRY_URL: z.string().optional(),
  PLUGIN_MAX_SIZE_MB: z.coerce.number().default(10),
  CLI_OUTPUT_FORMAT: z.enum(["text", "json"]).default("text"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const profile = profileSchema.parse(process.env.JUNBAN_PROFILE ?? "daily");
  const defaults = PROFILE_DEFAULTS[profile];

  return envSchema.parse({
    ...process.env,
    JUNBAN_PROFILE: profile,
    DB_PATH: process.env.DB_PATH ?? defaults.DB_PATH,
    MARKDOWN_PATH: process.env.MARKDOWN_PATH ?? defaults.MARKDOWN_PATH,
  });
}
