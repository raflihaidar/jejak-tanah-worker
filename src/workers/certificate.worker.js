// workers/certificate.worker.js
// Fix: publish event ke Redis setelah worker selesai, agar k6 bisa ukur keberhasilan
import { Worker } from "bullmq";
import { redisConnection, redisPublisher } from "../config/redis.js";
import "dotenv/config";

// const { generateCertificate } = process.env.BLOCKCHAIN_MOCK
//   ? await import("../services/certificate.service.mock.js")
//   : await import("../services/certificate.service.js");

const { generateCertificate } =
  await import("../services/certificate.service.js");

// ─── Channel Redis untuk notifikasi k6 ───────────────────────────────────────
// K6 akan poll endpoint HTTP yang subscribe channel ini
// Format pesan: JSON { jobId, fileNumber, status, durationMs, error? }
const CHANNEL = "certificate:done";

// ─── Helper: publish hasil ke Redis ──────────────────────────────────────────
async function publishResult(payload) {
  try {
    await redisPublisher.publish(CHANNEL, JSON.stringify(payload));
    console.log(`📢 Published ke [${CHANNEL}]:`, payload);
  } catch (err) {
    console.error("❌ Gagal publish ke Redis:", err.message);
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────
export const certificateWorker = new Worker(
  "certificate",
  async (job) => {
    const { fileNumber, notes } = job.data;
    const startedAt = Date.now();

    console.log(`\n🔧 Processing job ${job.id} — fileNumber: ${fileNumber}`);
    await job.updateProgress(10);

    await generateCertificate(fileNumber, notes);
    await job.updateProgress(100);

    const durationMs = Date.now() - startedAt;
    console.log(`✅ Job ${job.id} selesai dalam ${durationMs}ms`);

    return { success: true, durationMs };
  },
  {
    connection: redisConnection,
    concurrency: 5,

    // Fix: OOM — hapus job lama dari Redis secara otomatis
    removeOnComplete: { count: 500 }, // simpan max 500 job completed
    removeOnFail: { count: 100 }, // simpan max 100 job failed untuk debug
  },
);

// ─── Event: completed → publish sukses ───────────────────────────────────────
certificateWorker.on("completed", async (job, returnValue) => {
  console.log(`✅ [${job.id}] completed`);

  await publishResult({
    jobId: job.id,
    fileNumber: job.data.fileNumber,
    status: "completed",
    durationMs: returnValue?.durationMs ?? null,
    timestamp: Date.now(),
  });
});

// ─── Event: failed → publish gagal ───────────────────────────────────────────
certificateWorker.on("failed", async (job, err) => {
  console.error(`❌ [${job?.id}] failed:`, err.message);

  await publishResult({
    jobId: job?.id,
    fileNumber: job?.data?.fileNumber,
    status: "failed",
    error: err.message,
    timestamp: Date.now(),
  });
});

certificateWorker.on("error", (err) => {
  console.error("❌ Worker error:", err.message);
});
