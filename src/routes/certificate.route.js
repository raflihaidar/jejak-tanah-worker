import { Router } from "express";
import { addCertificateJob } from "../jobs/certificate.job.js";
import { certificateQueue } from "../queues/certificate.queue.js";

const router = Router();

// POST /api/certificate/issue
router.post("/issue", async (req, res) => {
  try {
    const { fileNumber, notes } = req.body;

    const job = await addCertificateJob({ fileNumber, notes });

    res.status(202).json({
      success: true,
      jobId: job.id,
      message: "Sertifikat sedang diproses",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Gagal menambahkan job" });
  }
});

// GET /api/certificate/status/:jobId
router.get("/status/:jobId", async (req, res) => {
  try {
    const job = await certificateQueue.getJob(req.params.jobId);

    if (!job) {
      res.status(404).json({ success: false, message: "Job tidak ditemukan" });
      return;
    }

    const state = await job.getState();
    const progress = job.progress;
    const result = job.returnvalue ?? null;
    const failedReason = job.failedReason ?? null;

    res.json({
      success: true,
      jobId: job.id,
      state, // waiting | active | completed | failed
      progress, // 0 - 100
      result,
      failedReason,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Gagal mengambil status" });
  }
});

export default router;
