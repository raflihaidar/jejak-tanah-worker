import {
  publicClient,
  walletClient,
  contractConfig,
  forwarderConfig,
} from "../config/wallet.js";

export const verifyForwardRequest = async (requestData) => {
  return await publicClient.readContract({
    ...forwarderConfig,
    functionName: "verify",
    args: [requestData],
  });
};

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
