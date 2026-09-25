const encode = new TextEncoder();
const decode = new TextDecoder();
export const toBase64 = (bytes) => {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 32768)
    s += String.fromCharCode(...b.subarray(i, i + 32768));
  return btoa(s);
};
export const fromBase64 = (s) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function passwordKey(password, salt, usage) {
  const base = await crypto.subtle.importKey(
    "raw",
    encode.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}
export async function createIdentity() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["wrapKey", "unwrapKey"],
  );
  return {
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}
export async function lockVault(id, privateData, password, auth) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt, ["encrypt"]);
  const bytes = encode.encode(JSON.stringify(privateData));
  try {
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encode.encode("community-vault:v1:" + id),
      },
      key,
      bytes,
    );
    return {
      version: 1,
      id,
      iterations: 600000,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(encrypted),
      ...(auth ? {auth} : {}),
    };
  } finally {
    bytes.fill(0);
  }
}
export async function unlockVault(record, password) {
  if (record.version !== 1 || record.iterations !== 600000)
    throw new Error("Unsupported private map.");
  const key = await passwordKey(password, fromBase64(record.salt), ["decrypt"]);
  let bytes;
  try {
    bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(record.iv),
          additionalData: encode.encode("community-vault:v1:" + record.id),
        },
        key,
        fromBase64(record.ciphertext),
      ),
    );
    return JSON.parse(decode.decode(bytes));
  } catch {
    throw new Error("Wrong password or damaged private map.");
  } finally {
    bytes?.fill(0);
  }
}
export async function openHandoff(envelope, privateJwk, expectedSessionId) {
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "RSA-OAEP-256+A256GCM" ||
    envelope.sessionId !== expectedSessionId
  )
    throw new Error("This import belongs to another session.");
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["unwrapKey"],
  );
  const aes = await crypto.subtle.unwrapKey(
    "raw",
    fromBase64(envelope.wrappedKey),
    privateKey,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(envelope.iv),
        additionalData: encode.encode("community-map:v1:" + expectedSessionId),
      },
      aes,
      fromBase64(envelope.ciphertext),
    ),
  );
  try {
    return JSON.parse(decode.decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
export async function vaultDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(
      "private-community-maps-v1:" + new URL("../", import.meta.url).pathname,
      1,
    );
    req.onupgradeneeded = () =>
      req.result.createObjectStore("vaults", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("Private storage is unavailable."));
  });
}
export async function persistVault(record, expectedCiphertext) {
  const db = await vaultDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("vaults", "readwrite");
      const put = () =>
        tx.objectStore("vaults").put({
          version: record.version,
          id: record.id,
          iterations: record.iterations,
          salt: record.salt,
          iv: record.iv,
          ciphertext: record.ciphertext,
          ...(record.auth ? {auth:record.auth} : {}),
        });
      if (expectedCiphertext === undefined) put();
      else {
        const read = tx.objectStore("vaults").get(record.id);
        read.onsuccess = () => {
          if ((read.result?.ciphertext ?? null) !== expectedCiphertext) {
            reject(
              new Error(
                "This map changed in another tab. Lock it and reopen before importing again.",
              ),
            );
            tx.abort();
          } else put();
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          new Error(
            "Could not save your private map. Free space and try again.",
          ),
        );
    });
  } finally {
    db.close();
  }
}
export async function listVaults() {
  const db = await vaultDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction("vaults").objectStore("vaults").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("Could not read private maps."));
    });
  } finally {
    db.close();
  }
}
export async function removeVault(id) {
  const db = await vaultDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("vaults", "readwrite");
      tx.objectStore("vaults").delete(id);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () =>
        reject(new Error("Could not remove the private map."));
    });
  } finally {
    db.close();
  }
}
