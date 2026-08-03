import { prisma } from "../config/prisma.js";
import handlebars from "handlebars";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  ApplicationStatus,
  CertificateStatus,
  MintingStatus,
} from "../generated/prisma/enums.ts";
import { parseEventLogs } from "viem";
import QRCode from "qrcode";
import crypto from "crypto";
import CryptoJS from "crypto-js";
import { AppError } from "../utils/error.js";
import { findHeadOfficeByLandOffice } from "./officer.service.js";
import {
  toCapitalize,
  formatDateIndonesia,
  imageToBase64,
} from "../utils/parse.js";
import { encrypt } from "eciesjs";
import { uploadFile } from "./pinata.service.js";
import {
  walletClient,
  publicClient,
  contractConfig,
} from "../config/wallet.js";
import { updateApplicationStatus } from "./application.service.js";
import { executeForwardRequest } from "./forwarder.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const encryptFile = (buffer) => {
  const aesKey = crypto.randomBytes(32); // private key
  const iv = crypto.randomBytes(12); // nonce

  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);

  // file yang sudah terenkripsi
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);

  const authTag = cipher.getAuthTag();

  return {
    encryptedBuffer: encrypted,
    aesKey,
    iv,
    authTag,
  };
};

const encryptAESKey = (aesKey, userPublicKeyHex) => {
  const publicKeyBuffer = Buffer.from(userPublicKeyHex, "hex");
  const encryptedBuffer = encrypt(publicKeyBuffer, Buffer.from(aesKey));
  return {
    encryptedKey: Buffer.from(encryptedBuffer).toString("base64"),
  };
};

export const createCertificate = async (payload) => {
  try {
    const {
      code,
      old_code,
      nib,
      land_id,
      application_id,
      cid,
      type,
      hash,
      notes,
      owners,
    } = payload;

    console.log("Memproses peralihan hak sertifikat baru: ", code);

    const result = await prisma.$transaction(async (tx) => {
      if (old_code) {
        const oldCert = await tx.certificate.findUnique({
          where: { code: old_code },
        });

        if (!oldCert) {
          throw new Error(
            `Sertifikat lama dengan kode ${old_code} tidak ditemukan.`,
          );
        }

        await tx.certificate.update({
          where: { code: old_code },
          data: { status: "TIDAK_AKTIF" },
        });
      }

      const certificate = await tx.certificate.create({
        data: {
          code,
          nib,
          land_id,
          hash,
          cid,
          type,
          status: "AKTIF",
          notes:
            notes && notes.length > 0
              ? {
                  createMany: {
                    data: notes.map((note) => ({ note })),
                  },
                }
              : undefined,
        },
      });

      if (owners && owners.length > 0) {
        await tx.certificateOwner.createMany({
          data: owners.map((o) => ({
            certificate_id: certificate.id,
            person_id: o.id,
            ownership_pct: o.share,
          })),
          skipDuplicates: true,
        });
      }

      await tx.application.update({
        where: { id: application_id },
        data: { cert_code: certificate.code },
      });

      return certificate;
    });

    return result;
  } catch (error) {
    console.error("Gagal melakukan peralihan hak sertifikat:", error);
    // Pastikan melempar (throw) eror agar controller di atasnya tahu proses gagal
    throw new AppError(`Gagal melakukan publish: ${error.message}`);
  }
};

export const generateQRDoc = async (tokenId) => {
  const url = `${process.env.FE_URL}/verify/certificate/${tokenId}`;

  try {
    const qrBase64 = await QRCode.toDataURL(url, {
      errorCorrectionLevel: "H",
      margin: 2,
      scale: 4,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });
    return qrBase64;
  } catch (err) {
    console.error("Gagal generate QR:", err);
    throw err;
  }
};

export const generateQRSignature = async (payload, encryptedPrivateKey) => {
  const decryptedPrivateKey = CryptoJS.AES.decrypt(
    encryptedPrivateKey,
    process.env.KEY_SECRET,
  ).toString(CryptoJS.enc.Utf8);

  const signature = crypto.sign(
    null,
    Buffer.from(payload),
    decryptedPrivateKey,
  );

  const data = {
    ...JSON.parse(payload),
    timestamp: new Date().toISOString(),
    signature: signature.toString("base64"),
  };

  const qrCode = await QRCode.toDataURL(JSON.stringify(data));

  return qrCode;
};

export const generateUniqueCode = (length = 6) => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  const randomSeed = Date.now().toString() + Math.random().toString();

  const hash = CryptoJS.SHA256(randomSeed).toString();

  let result = "";

  for (let i = 0; i < length; i++) {
    const index = parseInt(hash.substring(i * 2, i * 2 + 2), 16) % chars.length;

    result += chars[index];
  }

  return result;
};

export const generateNIB = async (
  provinceCode,
  regencyCode,
  districtCode,
  villageCode,
) => {
  const provStr = provinceCode.toString().padStart(2, "0");
  const regStr = (regencyCode % 100).toString().padStart(2, "0");
  const distStr = (districtCode % 100).toString().padStart(2, "0");
  const villStr = (villageCode % 100).toString().padStart(2, "0");

  const prefixNIB = `${provStr}.${regStr}.${distStr}.${villStr}`;

  const lastCertificate = await prisma.certificate.findFirst({
    where: {
      nib: {
        startsWith: prefixNIB,
      },
    },
    orderBy: {
      nib: "desc",
    },
    select: {
      nib: true,
    },
  });

  let nextSequence = 1;

  if (lastCertificate?.nib) {
    const parts = lastCertificate.nib.split(".");
    if (parts.length === 5) {
      const lastSequence = parseInt(parts[4], 10);
      if (!isNaN(lastSequence)) {
        nextSequence = lastSequence + 1;
      }
    }
  }

  const sequenceFormatted = nextSequence.toString().padStart(5, "0");

  return `${prefixNIB}.${sequenceFormatted}`;
};

export const buildCertificateAssets = async (application, headOffice) => {
  const templatePath = path.join(__dirname, "../templates/certificate.html");

  const templateHtml = fs.readFileSync(templatePath, "utf-8");

  const cssPath = path.join(__dirname, "../templates/certificate.css");

  const css = fs.readFileSync(cssPath, "utf-8");

  const htmlTemplate = templateHtml.replace(
    "</head>",
    `<style>${css}</style></head>`,
  );

  const garudaPath = path.join(__dirname, "../assets/lambang-pancasila.png");

  const garudaImage = imageToBase64(garudaPath);

  let code;
  code = generateUniqueCode(6);

  let nib;
  if (!application.nib) {
    nib = await generateNIB(
      application?.land?.province_code,
      application?.land?.regency_code,
      application?.land?.district_code,
      application?.land?.village_code,
    );
  } else {
    nib = application.nib;
  }

  const payload = JSON.stringify({
    code,
    nib,
    owner: application.person.name,
  });

  const qr_signature = await generateQRSignature(
    payload,
    headOffice.privateKey,
  );

  return {
    htmlTemplate,
    garudaImage,
    code,
    nib,
    qr_signature,
  };
};

export const buildCertificateAssetsForExisting = async (
  application,
  headOffice,
  code,
  nib,
) => {
  const templatePath = path.join(__dirname, "../templates/certificate.html");
  const templateHtml = fs.readFileSync(templatePath, "utf-8");

  const cssPath = path.join(__dirname, "../templates/certificate.css");
  const css = fs.readFileSync(cssPath, "utf-8");

  const htmlTemplate = templateHtml.replace(
    "</head>",
    `<style>${css}</style></head>`,
  );

  const garudaPath = path.join(__dirname, "../assets/lambang-pancasila.png");
  const garudaImage = imageToBase64(garudaPath);

  const payload = JSON.stringify({
    code,
    nib,
    owner: application.person.name,
  });

  const qr_signature = await generateQRSignature(
    payload,
    headOffice.privateKey,
  );

  return { htmlTemplate, garudaImage, qr_signature };
};

export const generatePDF = async (html) => {
  const browser = await puppeteer.launch({
    headless: true,
  });

  const page = await browser.newPage();

  await page.setContent(html, {
    waitUntil: "networkidle0",
  });

  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: {
      top: "0px",
      right: "0px",
      bottom: "0px",
      left: "0px",
    },
  });

  await browser.close();

  return pdfBuffer;
};

export const generateCertificate = async (fileNumber, notes, signedRequest) => {
  const application = await prisma.application.findUnique({
    where: { file_number: fileNumber },
    include: {
      land: {
        include: {
          province: true,
          regency: true,
          district: true,
          village: true,
        },
      },
      landOffice: true,
      certificate: true,
      person: true,
      owners: {
        include: {
          person: true,
        },
      },
    },
  });

  if (!application) {
    throw new Error("Application tidak ditemukan");
  }

  application.owners.forEach((owner) => {
    if (!owner.person.publicKey) {
      throw new AppError(
        `Owner ${owner.person.name} belum melakukan registrasi kunci publik.`,
        400,
      );
    }
    if (!owner.person.wallet_address) {
      throw new AppError(
        `Owner ${owner.person.name} belum memiliki wallet address.`,
        400,
      );
    }
  });

  const existingDraft =
    application.certificate &&
    [CertificateStatus.DRAFT, CertificateStatus.TERJADI_KESALAHAN].includes(
      application.certificate.status,
    )
      ? application.certificate
      : null;

  const hasExistingActiveCert =
    application.certificate?.status === "AKTIF"
      ? application.certificate
      : null;

  const headOffice = await findHeadOfficeByLandOffice(
    application.land_office_id,
  );

  let certificate;
  let code, nib, htmlTemplate, garudaImage, qr_signature;

  try {
    if (existingDraft) {
      console.log(
        `[Certificate] Melanjutkan draft existing: ${existingDraft.code}`,
      );
      certificate = existingDraft;
      code = existingDraft.code;
      nib = existingDraft.nib;

      const assets = await buildCertificateAssetsForExisting(
        application,
        headOffice,
        code,
        nib,
      );
      htmlTemplate = assets.htmlTemplate;
      garudaImage = assets.garudaImage;
      qr_signature = assets.qr_signature;
    } else {
      // Buat draft baru
      const assets = await buildCertificateAssets(application, headOffice);
      htmlTemplate = assets.htmlTemplate;
      garudaImage = assets.garudaImage;
      code = assets.code;
      nib = assets.nib;
      qr_signature = assets.qr_signature;

      certificate = await createCertificate({
        old_code: application.cert_code,
        nib,
        hash: "pending",
        code,
        land_id: application.land_id,
        status: CertificateStatus.DRAFT,
        type: application.type,
        application_id: application.id,
        notes,
        owners: application.owners.map((owner, index) => ({
          no: index + 1,
          id: owner.person.id,
          share: owner.share,
        })),
      });

      if (!certificate) {
        throw new AppError(
          "Sertifikat tanah gagal dibuat, silahkan periksa data administrasi kembali",
          400,
        );
      }
    }

    const previousTokenId =
      hasExistingActiveCert?.token_id ?? certificate.token_id;
    const isExistingNft = Boolean(previousTokenId);

    let tokenId;
    if (previousTokenId) {
      console.log("[Certificate] TokenId sudah ada, skip minting:", {
        tokenId: previousTokenId,
      });
      tokenId = previousTokenId;
    } else {
      tokenId = await mintingNft(certificate.id, signedRequest);
    }

    const template = handlebars.compile(htmlTemplate);

    const certificateType = [
      { label: "Hak Milik", value: "SHM" },
      { label: "Hak Guna Usaha", value: "SHGU" },
      { label: "Hak Guna Bangunan", value: "SHGB" },
    ];
    const selectedCertificateType = certificateType.find(
      (item) => item.value === application.type,
    );

    const owners = application.owners.map((owner, index) => ({
      no: index + 1,
      id: owner.person.id,
      name: owner.person.name,
      birthPlace: owner.person.birthPlace,
      birthDate: formatDateIndonesia(owner.person.birthDate),
      share: owner.share,
    }));

    const noteList = notes.map((n, index) => ({ no: index + 1, note: n }));

    const qrDocBase64 = await generateQRDoc(tokenId);

    const html = template({
      garuda_path: garudaImage,
      code,
      type: selectedCertificateType?.label ?? "-",
      area_size: application.land.area_size,
      owners,
      street_address: application.land.street_address,
      ward: toCapitalize(application.land.village.name),
      subdistrict: toCapitalize(application.land.district.name),
      regency: toCapitalize(application.land.regency.name),
      province: toCapitalize(application.land.province.name),
      nama_kepala_kantor: headOffice.name,
      nip: headOffice.nip,
      nama_kabupaten: toCapitalize(application.land.regency.name),
      nib,
      notes: noteList,
      qr_ttd: qr_signature,
      qr_doc: qrDocBase64,
    });

    const pdfBuffer = await generatePDF(html);

    const { encryptedBuffer, aesKey, iv, authTag } = encryptFile(
      Buffer.from(pdfBuffer),
    );

    const encryptedKeysForOwners = application.owners.map((owner) => {
      const wrapped = encryptAESKey(aesKey, owner.person.publicKey);
      return {
        walletAddress: owner.person.wallet_address,
        encryptedKey: wrapped.encryptedKey,
      };
    });

    aesKey.fill(0);

    const metadata = {
      pdfName: `${code}.pdf`,
      recipients: encryptedKeysForOwners,
      aesMetadata: {
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
      },
    };

    const uploadRes = await uploadFile(
      encryptedBuffer,
      `${code}.pdf`,
      metadata,
    );

    if (uploadRes?.cid) {
      if (isExistingNft) {
        await transferNFT(
          tokenId,
          application.person.wallet_address,
          uploadRes.cid,
        );
      } else {
        await setCertificateCID(tokenId, uploadRes.cid);
      }
    }

    const finalDocumentHash = crypto
      .createHash("sha256")
      .update(pdfBuffer)
      .digest("hex");

    await prisma.$transaction(async (tx) => {
      await tx.certificate.update({
        where: { id: certificate.id },
        data: {
          hash: finalDocumentHash,
          cid: uploadRes?.cid || null,
          token_id: tokenId,
          status: CertificateStatus.AKTIF,
        },
      });

      await updateApplicationStatus(application.id, "SELESAI", tx);
    });

    return pdfBuffer;
  } catch (error) {
    console.error("[Certificate] Proses gagal, melakukan kompensasi:", error);
    if (certificate?.id) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.certificate.update({
            where: { id: certificate.id },
            data: { status: CertificateStatus.TERJADI_KESALAHAN },
          });

          if (application.cert_code) {
            await tx.certificate.update({
              where: { code: application.cert_code },
              data: { status: CertificateStatus.AKTIF },
            });
          }
        });
      } catch (compensationError) {
        console.error(
          "[Certificate] Kompensasi juga gagal:",
          compensationError,
        );
      }
    }

    await updateApplicationStatus(
      application.id,
      ApplicationStatus.PENERBITAN_GAGAL,
    );

    throw new AppError(
      `Terjadi kesalahan pada saat generate certificate dengan code ${code}: ${error.message}`,
      400,
    );
  }
};

export const mintingNft = async (certificate_id, signedRequest) => {
  try {
    await prisma.certificate.update({
      where: { id: certificate_id },
      data: { minting_status: MintingStatus.PROCESSING },
    });

    const { txHash, receipt } = await executeForwardRequest(signedRequest);

    await prisma.certificate.update({
      where: { id: certificate_id },
      data: { tx_hash: txHash },
    });

    let tokenId;

    const mintLogs = parseEventLogs({
      abi: contractConfig.abi,
      eventName: "CertificateMinted",
      logs: receipt.logs,
    });

    if (mintLogs.length > 0) {
      tokenId = mintLogs[0].args.tokenId.toString();
    } else {
      const transferLogs = parseEventLogs({
        abi: contractConfig.abi,
        eventName: "OwnershipTransferredByBPN",
        logs: receipt.logs,
      });

      if (transferLogs.length > 0) {
        tokenId = transferLogs[0].args.tokenId.toString();
      } else {
        // Catatan: contract saat ini tidak punya getter semacam
        // `getActiveTokenIdByNib`, jadi tidak ada fallback lain untuk
        // menemukan tokenId selain dari event mint/transfer itu sendiri.
        // Kalau ini sering kejadian (mis. worker retry setelah tx sukses
        // tapi proses keburu mati), perlu ditambahkan mapping nib => tokenId
        // + view function di smart contract.
        throw new Error(
          "Event CertificateMinted/OwnershipTransferredByBPN tidak ditemukan di receipt",
        );
      }
    }

    await prisma.certificate.update({
      where: { id: certificate_id },
      data: {
        minting_status: MintingStatus.SUCCESS,
        token_id: Number(tokenId),
      },
    });

    return Number(tokenId);
  } catch (err) {
    console.log(err);
    await prisma.certificate.update({
      where: { id: certificate_id },
      data: { minting_status: MintingStatus.FAILED },
    });
    throw new AppError("Proses Minting NFT Gagal", 500, err.meta);
  }
};

export const setCertificateCID = async (tokenId, cid) => {
  try {
    if (!cid) {
      throw new Error("CID tidak boleh kosong");
    }

    console.log("[NFT] Set CID dimulai:", { tokenId, cid });

    const txHash = await walletClient.writeContract({
      ...contractConfig,
      functionName: "setCertificateCID",
      args: [BigInt(tokenId), cid],
      account: walletClient.account,
    });

    console.log("[NFT] Transaction sent:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    console.log("[NFT] Transaction confirmed:", {
      txHash,
      blockNumber: receipt.blockNumber,
    });

    return {
      txHash,
      receipt,
    };
  } catch (error) {
    console.error("[NFT] Failed setCertificateCID:", {
      tokenId,
      cid,
      error,
    });

    throw new Error("Gagal update CID ke smart contract");
  }
};

export const setCertificateCIDWithRetry = async (tokenId, cid, retry = 3) => {
  let lastError;

  for (let i = 1; i <= retry; i++) {
    try {
      console.log(`[NFT] Attempt ${i} setCID`);

      const result = await setCertificateCID(tokenId, cid);

      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[NFT] Retry ${i} gagal`, err);

      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }

  throw new Error("Gagal set CID setelah retry", { cause: lastError });
};

export const transferNFT = async (tokenId, newOwner, newCid) => {
  try {
    if (!newOwner) {
      throw new Error("Alamat newOwner tidak boleh kosong");
    }

    if (!newCid) {
      throw new Error("CID tidak boleh kosong");
    }

    console.log("[NFT] Transfer ownership dimulai:", {
      tokenId,
      newOwner,
      newCid,
    });

    const txHash = await walletClient.writeContract({
      ...contractConfig,
      functionName: "transferOwnershipByBPN",
      args: [BigInt(tokenId), newOwner, newCid],
      account: walletClient.account,
    });

    console.log("[NFT] Transaction sent:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    console.log("[NFT] Transaction confirmed:", {
      txHash,
      blockNumber: receipt.blockNumber,
    });

    return {
      txHash,
      receipt,
    };
  } catch (error) {
    console.error("[NFT] Failed transferOwnershipByBPN:", {
      tokenId,
      newOwner,
      newCid,
      error,
    });

    throw new Error("Gagal transfer ownership NFT ke smart contract");
  }
};
