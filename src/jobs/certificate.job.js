import { certificateQueue } from "../queues/certificate.queue.js";

export const addCertificateJob = async ({ fileNumber, notes }) => {
  const job = await certificateQueue.add(
    "issue-certificate",
    {
      fileNumber,
      notes,
    },
    {
      jobId: `cert-${fileNumber}-${Date.now()}`,
    },
  );

  console.log(`📋 Job added: ${job.id}`);
  return job;
};
