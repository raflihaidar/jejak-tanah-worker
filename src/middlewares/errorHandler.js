export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  res.status(statusCode).json({
    status: "error",
    message: message,
    error: {
      code: statusCode,
      details: err.details || "Something went wrong on the server.",
    },
  });
};
