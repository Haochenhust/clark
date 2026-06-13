import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/kernel/*/data/schema.ts",
    "./src/providers/**/data/schema.ts",
  ],
  dialect: "sqlite",
  out: "./drizzle",
});
