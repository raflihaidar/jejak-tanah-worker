// config/redis.js
import { Redis } from "ioredis";
import "dotenv/config";

// ─── Koneksi BullMQ (worker, queue) ──────────────────────────────────────────
// JANGAN tambah commandTimeout — BullMQ pakai BRPOP/XREAD yang long-running
export const redisConnection = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,

  maxRetriesPerRequest: null, // wajib null untuk BullMQ
  enableReadyCheck: false, // wajib false untuk BullMQ
  enableOfflineQueue: true,
  socketKeepAlive: true,

  retryStrategy(times) {
    if (times > 5) {
      console.error(`❌ Redis [main] retry ${times}x — berhenti`);
      return null;
    }
    const delay = Math.min(times * 300, 3_000);
    console.warn(`⚠️  Redis [main] retry ke-${times} dalam ${delay}ms`);
    return delay;
  },
});

// ─── Koneksi publisher & subscriber (pub/sub biasa) ───────────────────────────
// Boleh pakai commandTimeout karena tidak ada long-running command
const PUBSUB_OPTIONS = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,

  connectTimeout: 10_000,
  commandTimeout: 5_000, // aman untuk pub/sub
  socketKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  enableOfflineQueue: true,

  retryStrategy(times) {
    if (times > 5) return null;
    return Math.min(times * 300, 3_000);
  },
};

export const redisSubscriber = new Redis(PUBSUB_OPTIONS);
export const redisPublisher = new Redis(PUBSUB_OPTIONS);

// ─── Event listeners ──────────────────────────────────────────────────────────
function attachListeners(client, name) {
  client.on("connect", () => console.log(`✅ Redis [${name}] connected`));
  client.on("ready", () => console.log(`✅ Redis [${name}] ready`));
  client.on("error", (err) =>
    console.error(`❌ Redis [${name}] error:`, err.message),
  );
  client.on("close", () =>
    console.warn(`⚠️  Redis [${name}] connection closed`),
  );
  client.on("reconnecting", (ms) =>
    console.warn(`🔄 Redis [${name}] reconnecting in ${ms}ms`),
  );
  client.on("end", () => console.warn(`🔴 Redis [${name}] connection ended`));
}

attachListeners(redisConnection, "main");
attachListeners(redisSubscriber, "subscriber");
attachListeners(redisPublisher, "publisher");
