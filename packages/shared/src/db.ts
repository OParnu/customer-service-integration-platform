import pg from "pg";
import { logger } from "./logger.js";

const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  pool.on("error", (error) => {
    logger.error({ err: error }, "unexpected idle PostgreSQL client error");
  });
  return pool;
}

