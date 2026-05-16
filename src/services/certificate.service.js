import { prisma } from "../config/prisma.js";
import handlebars from "handlebars";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CertificateStatus, MintingStatus } from "../generated/prisma/enums.ts";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const encryptFile = (buffer) => {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);

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

  // 2. Proses Enkripsi ECIES
  // eciesjs melakukan: KEM (Key Encapsulation) + AES-GCM secara otomatis
  const encryptedBuffer = encrypt(publicKeyBuffer, Buffer.from(aesKey));

  // 3. Kembalikan hasil dalam format Base64 (atau Hex) untuk disimpan
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
    const result = await prisma.$transaction(async (tx) => {
      await tx.certificate.update({
        where: {
          code: old_code,
        },
        data: {
          status: CertificateStatus.TIDAK_AKTIF,
        },
      });

      const certificate = await tx.certificate.upsert({
        where: {
          application_id,
        },
        update: {},
        create: {
          code,
          nib,
          land_id,
          application_id,
          hash,
          cid,
          type,
          notes: {
            createMany: {
              data: notes.map((note) => ({
                note,
              })),
            },
          },
        },
      });

      await tx.certificateOwner.createMany({
        data: owners.map((o) => ({
          certificate_id: certificate.id,
          person_id: o.id,
          ownership_pct: o.share,
        })),
        skipDuplicates: true,
      });

      return certificate;
    });
    return result;
  } catch (error) {
    console.log("error : ", error);
    new AppError("Gagal melakukan publish");
  }
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

export const generateNIB = async (provinceCode, regencyCode, indeksLetak) => {
  if (indeksLetak < 0 || indeksLetak > 9) {
    throw new Error("Indeks letak harus antara 0 - 9");
  }

  const lastCertificate = await prisma.certificate.findFirst({
    where: {
      land: {
        province_code: provinceCode,
        regency_code: regencyCode,
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
    const lastSequence = lastCertificate.nib.slice(6, 15);
    nextSequence = parseInt(lastSequence) + 1;
  }

  const sequenceFormatted = nextSequence.toString().padStart(9, "0");

  const formatedRegencyCode = regencyCode % 100;

  const nib =
    provinceCode.toString().padStart(2, "0") +
    "." +
    formatedRegencyCode.toString().padStart(2, "0") +
    "." +
    sequenceFormatted +
    "." +
    indeksLetak.toString();

  return nib;
};

export const buildCertificateAssets = async (
  application,
  headOffice,
  hasExistingCert,
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

  let code;
  if (!hasExistingCert) {
    code = generateUniqueCode(6);
  } else {
    code = hasExistingCert?.code;
  }

  let nib;
  if (!application.nib) {
    nib = await generateNIB(
      application?.land?.province_code,
      application?.land?.regency_code,
      1,
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

export const generateCertificate = async (fileNumber, notes) => {
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

  const hasExistingCert = application.certificate;

  const headOffice = await findHeadOfficeByLandOffice(
    application.land_office_id,
  );

  const { htmlTemplate, garudaImage, code, nib, qr_signature } =
    await buildCertificateAssets(application, headOffice, hasExistingCert);

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

  const noteList = notes.map((n, index) => ({
    no: index + 1,
    note: n,
  }));

  try {
    // ─── 1. Buat certificate record dulu (tanpa CID) ───────────────────────
    const documentHash = "pending"; // placeholder, akan diupdate setelah PDF final

    const certificate = await createCertificate({
      old_code: application.cert_code,
      nib,
      hash: documentHash,
      code,
      land_id: application.land_id,
      status: CertificateStatus.AKTIF,
      type: application.type,
      application_id: application.id,
      notes,
      owners,
    });

    if (!certificate) {
      throw new AppError(
        "Sertifikat tanah gagal dibuat, silahkan periksa data",
        400,
      );
    }

    // ─── 2. Mint NFT untuk mendapatkan tokenId ─────────────────────────────
    const tokenId = await mintingNft(
      certificate.id,
      application.person.wallet_address,
    );

    // ─── 3. Generate HTML dengan qr_doc yang sudah ada tokenId ─────────────
    // const qrDocUrl = `${process.env.FE_URL}?tokenId=${tokenId}`;

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

    // ─── 4. Generate PDF ────────────────────────────────────────────────────
    const pdfBuffer = await generatePDF(html);

    // ─── 5. Enkripsi PDF ────────────────────────────────────────────────────
    const { encryptedBuffer, aesKey, iv, authTag } = encryptFile(
      Buffer.from(pdfBuffer),
    );

    const encryptedKeysForOwners = application.owners.map((owner) => {
      const userPubKey = owner.person.publicKey;

      if (!userPubKey) {
        throw new Error(
          `Owner ${owner.person.name} belum melakukan registrasi kunci publik.`,
        );
      }

      const wrapped = encryptAESKey(aesKey, userPubKey);

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

    // ─── 6. Upload ke IPFS ──────────────────────────────────────────────────
    const uploadRes = await uploadFile(
      encryptedBuffer,
      `${code}.pdf`,
      metadata,
    );

    if (uploadRes?.cid) {
      await setCertificateCID(tokenId, uploadRes?.cid);
    }

    // ─── 7. Update certificate dengan hash & CID yang final ────────────────
    const finalDocumentHash = crypto
      .createHash("sha256")
      .update(pdfBuffer)
      .digest("hex");

    await prisma.certificate.update({
      where: { id: certificate.id },
      data: {
        hash: finalDocumentHash,
        cid: uploadRes?.cid || null,
      },
    });

    return pdfBuffer;
  } catch (error) {
    console.log(error);
    throw new AppError(
      `Terjadi kesalahan pada saat generate certificate dengan code ${code}`,
      400,
    );
  }
};

export const mintingNft = async (certificate_id, userAddress) => {
  try {
    await prisma.certificate.update({
      where: { id: certificate_id },
      data: { minting_status: MintingStatus.PROCESSING },
    });

    const hash = await walletClient.writeContract({
      ...contractConfig,
      functionName: "mintCertificate",
      args: [userAddress],
    });

    await prisma.certificate.update({
      where: { id: certificate_id },
      data: { tx_hash: hash },
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const logs = parseEventLogs({
      abi: contractConfig.abi,
      eventName: "CertificateMinted",
      logs: receipt.logs,
    });

    if (logs.length === 0)
      throw new Error("Event CertificateMinted tidak ditemukan");

    const tokenId = logs[0].args.tokenId.toString();

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

    // optional: wait for confirmation
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
