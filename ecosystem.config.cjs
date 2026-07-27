module.exports = {
  apps: [
    {
      name: "jejak-tanahku-worker",
      cwd: __dirname,
      script: "./src/worker.js",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
    },
  ],
};
