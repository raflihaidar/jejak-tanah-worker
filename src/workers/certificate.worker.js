import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { generateCertificate } from "../services/certificate.service.js";

export const certificateWorker = new Worker(
  "certificate",
  async (job) => {
    const { fileNumber, notes } = job.data;

    console.log(`🚀 Processing job ${job.id} — fileNumber: ${fileNumber}`);

    await job.updateProgress(10);

    // semua logic ada di sini: PDF, enkripsi, IPFS, minting NFT, update DB
    const pdfBuffer = await generateCertificate(fileNumber, notes);

    await job.updateProgress(100);

    return { success: true };
  },
  {
    connection: redisConnection,
    concurrency: 5,
  },
);

certificateWorker.on("completed", (job) => {
  console.log(`✅ [${job.id}] completed`);
});

certificateWorker.on("failed", (job, err) => {
  console.error(`❌ [${job?.id}] failed:`, err.message);
});
