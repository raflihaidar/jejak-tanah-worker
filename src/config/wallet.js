import { createPublicClient, createWalletClient, http, webSocket } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import CertificateABI from "../abi/certificateNFT.json" with { type: "json" };

const RPC_URL = process.env.RPC_URL;
const WS_RPC_URL = process.env.RPC_WS_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ADMIN_PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC_URL) {
  throw new Error("RPC_URL is not defined in environment variables");
}

if (!CONTRACT_ADDRESS) {
  throw new Error("CONTRACT_ADDRESS is not defined in environment variables");
}

if (!ADMIN_PRIVATE_KEY) {
  throw new Error("ADMIN_PRIVATE_KEY is not defined in environment variables");
}

const adminAccount = privateKeyToAccount(ADMIN_PRIVATE_KEY);

export const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: http(RPC_URL),
});

export const walletClient = createWalletClient({
  account: adminAccount,
  chain: polygonAmoy,
  transport: http(RPC_URL),
});

export const contractConfig = {
  address: CONTRACT_ADDRESS,
  abi: CertificateABI,
};

export const wsPublicClient = createPublicClient({
  chain: polygonAmoy,
  transport: webSocket(WS_RPC_URL),
});
