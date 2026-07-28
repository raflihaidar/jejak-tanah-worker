import { Worker } from "bullmq";
import { redisConnection, redisPublisher } from "../config/redis.js";
import "dotenv/config";

const { generateCertificate } =
  await import("../services/certificate.service.js");

const CHANNEL = "certificate:done";

async function publishResult(payload) {
  try {
    await redisPublisher.publish(CHANNEL, JSON.stringify(payload));
    console.log(`Published ke [${CHANNEL}]:`, payload);
  } catch (err) {
    console.error("Gagal publish ke Redis:", err.message);
  }
}

function normalizeSignedRequest(signedRequest) {
  if (!signedRequest) return signedRequest;

  return {
    ...signedRequest,
    value: BigInt(signedRequest.value),
    gas: BigInt(signedRequest.gas),
  };
}

export const certificateWorker = new Worker(
  "certificate",
  async (job) => {
    const { fileNumber, notes, signedRequest } = job.data;
    const startedAt = Date.now();

    if (!signedRequest?.signature) {
      throw new Error(
        `Job ${job.id} tidak memiliki signedRequest yang valid — kemungkinan job lama sebelum forwarder diimplementasikan`,
      );
    }

    console.log(`\nProcessing job ${job.id} — fileNumber: ${fileNumber}`);
    await job.updateProgress(10);

    const normalizedRequest = normalizeSignedRequest(signedRequest);

    await generateCertificate(fileNumber, notes, normalizedRequest);
    await job.updateProgress(100);

    const durationMs = Date.now() - startedAt;
    console.log(`Job ${job.id} selesai dalam ${durationMs}ms`);

    return { success: true, durationMs };
  },
  {
    connection: redisConnection,
    concurrency: 5,
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 100 },
  },
);

certificateWorker.on("completed", async (job, returnValue) => {
  await publishResult({
    jobId: job.id,
    fileNumber: job.data.fileNumber,
    status: "completed",
    durationMs: returnValue?.durationMs ?? null,
    timestamp: Date.now(),
  });
});

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
