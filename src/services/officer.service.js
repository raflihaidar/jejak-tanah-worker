import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/error.js";

export const findHeadOfficeByLandOffice = async (land_office_id) => {
  try {
    const headOffice = await prisma.person.findFirst({
      where: {
        land_office_id,
      },
    });

    if (!headOffice) {
      throw new AppError("Kepala kantah tidak ditemukan", 404);
    }

    return headOffice;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError("Gagal mencari kepala kantah", 500, error.meta);
  }
};
