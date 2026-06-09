import { prisma } from "../config/prisma.js";
import { CertificateStatus } from "../generated/prisma/enums.ts";
import { formatDateIndonesia } from "../utils/parse.js";
import {
  createCertificate,
  buildCertificateAssets,
} from "./certificate.service.js";
import { findHeadOfficeByLandOffice } from "./officer.service.js";

// ─── Debug Logger ──────────────────────────────────────────────────────────────
const log = {
  section: (title) => {
    console.log("\n" + "═".repeat(60));
    console.log(`  ${title}`);
    console.log("═".repeat(60));
  },
  step: (label) => {
    console.log("\n" + "─".repeat(50));
    console.log(`  ▶ ${label}`);
    console.log("─".repeat(50));
  },
  data: (label, data) => {
    console.log(`\n📦 ${label}:`);
    try {
      console.log(JSON.stringify(data, jsonReplacer, 2));
    } catch {
      console.log(String(data));
    }
  },
  ok: (msg) => console.log(`✅ ${msg}`),
  err: (msg, err) => {
    console.log(`❌ ${msg}`);
    if (err) {
      console.log(`   Message : ${err.message}`);
      console.log(
        `   Stack   : ${err.stack?.split("\n").slice(0, 3).join(" | ")}`,
      );
    }
  },
  warn: (msg) => console.log(`⚠️  ${msg}`),
  info: (msg) => console.log(`ℹ️  ${msg}`),
  timing: (label, ms) => console.log(`⏱  ${label}: ${ms.toFixed(2)} ms`),
};

// Replacer agar Date & BigInt tidak error di JSON.stringify
function jsonReplacer(key, value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  return value;
}

// ─── Timer helper ──────────────────────────────────────────────────────────────
function timer() {
  const start = Date.now();
  return () => Date.now() - start;
}

// ─── generateCertificate (dengan debug penuh) ─────────────────────────────────
export const generateCertificate = async (fileNumber, notes) => {
  log.section(`generateCertificate — START`);
  log.data("Input args", { fileNumber, notes });

  // ── 1. Prisma: findUnique application ─────────────────────────────────────
  log.step("1. prisma.application.findUnique");
  log.data("Query where", { file_number: fileNumber });

  let application;
  const t1 = timer();
  try {
    application = await prisma.application.findUnique({
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
          include: { person: true },
        },
      },
    });
    log.timing("findUnique", t1());
    log.data("application", application);
  } catch (err) {
    log.err("prisma.application.findUnique GAGAL", err);
    throw err;
  }

  if (!application) {
    log.err(`Application dengan file_number '${fileNumber}' tidak ditemukan`);
    throw new Error(`Application tidak ditemukan: ${fileNumber}`);
  }
  log.ok(`Application ditemukan — id: ${application.id}`);

  // ── 2. findHeadOfficeByLandOffice ─────────────────────────────────────────
  log.step("2. findHeadOfficeByLandOffice");
  log.data("Input land_office_id", application.land_office_id);

  let headOffice;
  const t2 = timer();
  try {
    headOffice = await findHeadOfficeByLandOffice(application.land_office_id);
    log.timing("findHeadOfficeByLandOffice", t2());
    log.data("headOffice", headOffice);
  } catch (err) {
    log.err("findHeadOfficeByLandOffice GAGAL", err);
    throw err;
  }

  if (!headOffice) {
    log.warn(
      "headOffice null — lanjut tapi mungkin error di buildCertificateAssets",
    );
  } else {
    log.ok(`headOffice ditemukan — id: ${headOffice.id}`);
  }

  // ── 3. buildCertificateAssets ─────────────────────────────────────────────
  log.step("3. buildCertificateAssets");
  const hasExistingCert = application.certificate;
  log.data("hasExistingCert", hasExistingCert);
  log.data("application (ringkas) dikirim ke buildCertificateAssets", {
    id: application.id,
    type: application.type,
    land_office_id: application.land_office_id,
    land_id: application.land_id,
    cert_code: application.cert_code,
    person: application.person,
    land: application.land,
    owners: application.owners,
  });

  let code, nib;
  const t3 = timer();
  try {
    ({ code, nib } = await buildCertificateAssets(
      application,
      headOffice,
      hasExistingCert,
    ));
    log.timing("buildCertificateAssets", t3());
    log.data("buildCertificateAssets result", { code, nib });
  } catch (err) {
    log.err("buildCertificateAssets GAGAL", err);
    throw err;
  }
  log.ok(`code: ${code} | nib: ${nib}`);

  // ── 4. Build owners array ─────────────────────────────────────────────────
  log.step("4. Build owners array");
  const owners = application.owners.map((owner, index) => ({
    no: index + 1,
    id: owner.person.id,
    name: owner.person.name,
    birthPlace: owner.person.birthPlace,
    birthDate: formatDateIndonesia(owner.person.birthDate),
    share: owner.share,
  }));
  log.data("owners", owners);

  // ── 5. createCertificate ──────────────────────────────────────────────────
  log.step("5. createCertificate (insert ke Postgres)");
  const documentHash = "pending";
  const createInput = {
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
  };
  log.data("createCertificate input", createInput);

  let result;
  const t5 = timer();
  try {
    result = await createCertificate(createInput);
    log.timing("createCertificate", t5());
    log.data("createCertificate result", result);
  } catch (err) {
    log.err("createCertificate GAGAL", err);
    throw err;
  }

  if (!result) {
    log.err("createCertificate return null/undefined");
    throw new Error("Sertifikat tanah gagal dibuat, silahkan periksa data");
  }
  log.ok(`Certificate dibuat — id: ${result.id}, code: ${result.code}`);

  // ── 6. [MOCK] Minting NFT ─────────────────────────────────────────────────
  log.step("6. [MOCK] mintingNft — SKIPPED");
  const mockTokenId = `token-${Date.now()}`;
  log.info(`mockTokenId: ${mockTokenId}`);
  await new Promise((r) => setTimeout(r, 5));
  log.ok("mintingNft mock selesai (5ms delay)");

  // ── 7. [MOCK] Generate PDF + Encrypt + IPFS ───────────────────────────────
  log.step("7. [MOCK] generatePDF + encryptFile + IPFS upload — SKIPPED");
  const mockPdfBuffer = Buffer.from(`mock-pdf-${fileNumber}`);
  const mockCid = `Qm${Math.random().toString(36).slice(2, 38)}`;
  log.info(`mockCid: ${mockCid}`);
  log.info(`mockPdfBuffer: ${mockPdfBuffer.length} bytes`);

  // ── 8. prisma.certificate.update (hash + CID) ─────────────────────────────
  log.step("8. prisma.certificate.update (hash + CID)");
  const finalHash = `mock-hash-${Date.now()}`;
  const updateInput = {
    where: { id: result.id },
    data: { hash: finalHash, cid: mockCid },
  };
  log.data("update input", updateInput);

  let updated;
  const t8 = timer();
  try {
    updated = await prisma.certificate.update(updateInput);
    log.timing("certificate.update", t8());
    log.data("certificate.update result", updated);
  } catch (err) {
    log.err("prisma.certificate.update GAGAL", err);
    throw err;
  }
  log.ok(`Certificate diupdate — hash: ${finalHash}, cid: ${mockCid}`);

  // ── Done ──────────────────────────────────────────────────────────────────
  log.section("generateCertificate — DONE");
  log.data("Summary", {
    fileNumber,
    applicationId: application.id,
    certificateId: result.id,
    code: result.code,
    nib,
    mockTokenId,
    mockCid,
    finalHash,
  });

  return mockPdfBuffer;
};
