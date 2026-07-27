`import { encodeFunctionData } from "viem";`;
import {
  publicClient,
  walletClient,
  contractConfig,
  forwarderConfig,
} from "../config/wallet.js";

// Dipakai worker untuk validasi ulang sebelum eksekusi —
// job bisa sempat mengantre lama, jadi deadline dari signature
// awal bisa saja sudah lewat saat giliran job ini diproses.
export const verifyForwardRequest = async (requestData) => {
  return await publicClient.readContract({
    ...forwarderConfig,
    functionName: "verify",
    args: [requestData],
  });
};

// Dipanggil setelah aset sertifikat siap — relayer (walletClient) yang
// submit & bayar gas, tapi _msgSender() on-chain tetap resolve ke petugas
export const executeForwardRequest = async (requestData) => {
  const isValid = await verifyForwardRequest(requestData);

  if (!isValid) {
    throw new Error(
      "Signature forward request tidak valid, kadaluarsa, atau nonce sudah terpakai",
    );
  }

  const txHash = await walletClient.writeContract({
    ...forwarderConfig,
    functionName: "execute",
    args: [requestData],
    account: walletClient.account,
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  return { txHash, receipt };
};
