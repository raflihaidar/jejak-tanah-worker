import { AppError } from "../utils/error.js";
import { prisma } from "../config/prisma.js";

export const updateApplicationStatus = async (id, status, client = prisma) => {
  try {
    const application = await client.application.update({
      where: {
        id,
      },
      data: {
        status,
      },
    });

    return application;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      "Terjadi kesalahan saat update status permohonan",
      500,
      error?.meta,
    );
  }
};
