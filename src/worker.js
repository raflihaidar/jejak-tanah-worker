import "dotenv/config";
import { certificateWorker } from "./workers/certificate.worker.js";

console.log("👷 Worker started, waiting for jobs...");

// Graceful shutdown
const shutdown = async () => {
  console.log("⏳ Shutting down worker...");
  await certificateWorker.close();
  console.log("✅ Worker closed");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
