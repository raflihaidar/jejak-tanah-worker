import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const certificateQueue = new Queue("certificate", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000, // retry: 5s, 10s, 20s
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});
