import { prisma } from "../config/prisma.js";
import { CertificateStatus } from "../generated/prisma/enums.ts";
import { formatDateIndonesia } from "../utils/parse.js";
import {
  createCertificate,
  buildCertificateAssets,
} from "./certificate.service.js";
import { findHeadOfficeByLandOffice } from "./officer.service.js";

// Data dummy yang merepresentasikan hasil query Prisma
const MOCK_APPLICATION = {
  id: "app-mock-001",
  type: "SHM",
  land_office_id: "lo-001",
  land_id: "land-001",
  cert_code: "OLD-001",
  person: {
    wallet_address: "0xMockWallet123",
    publicKey: "mock-public-key",
  },
  land: {
    area_size: 150,
    street_address: "Jl. Mock No. 1",
    village: { name: "desa mock" },
    district: { name: "kecamatan mock" },
    regency: { name: "kab mock" },
    province: { name: "jawa timur" },
  },
  landOffice: { name: "Kantor Pertanahan Mock", id: "lo-001" },
  certificate: null,
  owners: [
    {
      share: "1/1",
      person: {
        id: "person-001",
        name: "Budi Santoso Mock",
        birthPlace: "Surabaya",
        birthDate: new Date("1990-01-01"),
        wallet_address: "0xOwner123",
        publicKey: "owner-mock-pubkey",
      },
    },
  ],
};

export const generateCertificate = async (fileNumber, notes) => {
  console.log(`[MOCK] generateCertificate — fileNumber: ${fileNumber}`);

  const mockCode = `CERT-MOCK-${Date.now()}`;
  const mockNib = `NIB-${Math.floor(Math.random() * 999999)}`;
  const mockTokenId = `token-${Date.now()}`;
  const mockCid = `Qm${Math.random().toString(36).slice(2, 38)}`;
  const mockTxHash = `0x${Math.random().toString(16).slice(2, 66)}`;

  // Dapatkan application nya
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
    console.log("Application tidak ditemukan");
  }

  const hasExistingCert = application.certificate;

  const headOffice = await findHeadOfficeByLandOffice(
    application.land_office_id,
  );

  const { code, nib } = await buildCertificateAssets(
    application,
    headOffice,
    hasExistingCert,
  );

  const documentHash = "pending";

  const owners = application.owners.map((owner, index) => ({
    no: index + 1,
    id: owner.person.id,
    name: owner.person.name,
    birthPlace: owner.person.birthPlace,
    birthDate: formatDateIndonesia(owner.person.birthDate),
    share: owner.share,
  }));

  // ─── 1. Skip: prisma.application.findUnique (pakai data mock) ──────────

  // ─── 2. Skip: buildCertificateAssets (heavy I/O) ───────────────────────

  // ─── 3. NYATA: createCertificate insert ke Postgres ────────────────────
  const result = await createCertificate({
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

  if (!result) {
    console.log("Sertifikat tanah gagal dibuat, silahkan periksa data");
  }

  // ─── 4. Skip: mintingNft (blockchain) → return fake tokenId ────────────
  console.log(`[MOCK] mintingNft skipped → tokenId: ${mockTokenId}`);
  await new Promise((r) => setTimeout(r, 5)); // simulasi latency minimal

  // ─── 5. Skip: generatePDF + encryptFile (CPU berat) ────────────────────
  const mockPdfBuffer = Buffer.from(`mock-pdf-${fileNumber}`);

  // ─── 6. Skip: uploadFile IPFS → return fake CID ────────────────────────
  console.log(`[MOCK] IPFS upload skipped → cid: ${mockCid}`);

  // ─── 7. NYATA: prisma.certificate.update (hash + CID) ──────────────────
  const finalHash = `mock-hash-${Date.now()}`;
  await prisma.certificate.update({
    where: { id: result.id },
    data: {
      hash: finalHash,
      cid: mockCid,
    },
  });

  console.log(
    `[MOCK] Done — code: ${mockCode}, tokenId: ${mockTokenId}, 'cert_code : ', ${result?.code}`,
  );
  return mockPdfBuffer;
};
