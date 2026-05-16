import "dotenv/config";
import express from "express";
import cors from "cors";
import certificateRoute from "./routes/certificate.route.js";

const app = express();
const PORT = process.env.APP_PORT ?? 3000;

app.use(cors());
app.use(express.json());

app.use("/api/certificate", certificateRoute);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
