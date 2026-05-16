import FormData from "form-data";
import axios from "axios";

export const uploadFile = async (encryptedBuffer, fileName, metadata) => {
  try {
    const folderName = fileName.replace(".pdf", "");
    const formData = new FormData();

    formData.append("file", encryptedBuffer, {
      filepath: `${folderName}/${fileName}`,
      contentType: "application/octet-stream",
    });

    const metadataJSON = {
      fileName,
      recipients: metadata.recipients,
      aes: {
        iv: metadata.aesMetadata.iv,
        authTag: metadata.aesMetadata.authTag,
      },
      createdAt: new Date().toISOString(),
    };

    formData.append("file", Buffer.from(JSON.stringify(metadataJSON)), {
      filepath: `${folderName}/metadata.json`,
      contentType: "application/json",
    });

    const res = await axios.post(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${process.env.PINATA_JWT}`,
        },
      },
    );

    const rootCid = res.data.IpfsHash;

    return {
      cid: rootCid,
    };
  } catch (error) {
    console.error("Upload IPFS Error:", error?.response?.data || error);
    throw new Error("Gagal upload ke Pinata");
  }
};
