import { createHmac, createHash, randomUUID } from "node:crypto";

export interface UpbitCredentials {
  accessKey: string;
  secretKey: string;
}

export function buildUpbitJwtToken(credentials: UpbitCredentials, queryString?: string): string {
  const header = base64UrlEncode(
    JSON.stringify({
      alg: "HS512",
      typ: "JWT",
    }),
  );

  const payload: Record<string, string> = {
    access_key: credentials.accessKey,
    nonce: randomUUID(),
  };

  if (queryString) {
    payload.query_hash = sha512Hex(queryString);
    payload.query_hash_alg = "SHA512";
  }

  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha512", credentials.secretKey)
    .update(`${header}.${payloadSegment}`, "utf8")
    .digest("base64url");

  return `${header}.${payloadSegment}.${signature}`;
}

export function buildUpbitQueryString(
  params: Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>,
): string {
  return Object.entries(params)
    .flatMap(([key, value]) => {
      if (value === null || typeof value === "undefined") {
        return [];
      }

      if (Array.isArray(value)) {
        return value.map((entry) => `${key}=${String(entry)}`);
      }

      return [`${key}=${String(value)}`];
    })
    .join("&");
}

export function sha512Hex(input: string): string {
  return createHash("sha512").update(input, "utf8").digest("hex");
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
