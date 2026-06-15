import { createRemoteLayout } from "../core/paths";
import { createEmptyManifest, type ObjectStore, type RemoteManifest } from "../sync/engine";

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer;
}

interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
}

interface S3ObjectStoreOptions {
  endpoint: string;
  bucket: string;
  addressingStyle: S3AddressingStyle;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  rootPrefix: string;
  vaultId: string;
  deviceId: string;
  now(): number;
  request(request: HttpRequest): Promise<HttpResponse>;
}

export type S3AddressingStyle = "auto" | "path" | "virtual-hosted";

export class S3ObjectStore implements ObjectStore {
  private options: S3ObjectStoreOptions;
  private layout: ReturnType<typeof createRemoteLayout>;

  constructor(options: S3ObjectStoreOptions) {
    this.options = options;
    this.layout = createRemoteLayout({
      rootPrefix: options.rootPrefix,
      vaultId: options.vaultId,
    });
  }

  async acquireLock(): Promise<boolean> {
    const lock = await this.request("GET", this.layout.lockKey);

    if (lock.status === 200) {
      const parsed = safeParseJson(lock.text) as { expiresAt?: number } | null;
      if (parsed?.expiresAt && parsed.expiresAt > this.options.now()) {
        return false;
      }
    }

    const body = JSON.stringify({
      owner: this.options.deviceId,
      expiresAt: this.options.now() + 30_000,
    });
    const written = await this.request("PUT", this.layout.lockKey, new TextEncoder().encode(body));
    return written.status >= 200 && written.status < 300;
  }

  async releaseLock(): Promise<void> {
    await this.request("DELETE", this.layout.lockKey);
  }

  async readManifest(): Promise<RemoteManifest> {
    const response = await this.request("GET", this.layout.manifestKey);

    if (response.status === 404) {
      return createEmptyManifest();
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to read manifest: HTTP ${response.status}`);
    }

    return Object.assign(createEmptyManifest(), JSON.parse(response.text)) as RemoteManifest;
  }

  async writeManifest(manifest: RemoteManifest): Promise<void> {
    const response = await this.request("PUT", this.layout.manifestKey, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    assertOk(response.status, "write manifest");
  }

  async readObject(key: string): Promise<Uint8Array> {
    const response = await this.request("GET", this.resolveKey(key));
    assertOk(response.status, `read object ${key}`);
    return new Uint8Array(response.arrayBuffer);
  }

  async writeObject(key: string, bytes: Uint8Array): Promise<void> {
    const response = await this.request("PUT", this.resolveKey(key), bytes);
    assertOk(response.status, `write object ${key}`);
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", this.resolveKey(key));
    assertOk(response.status, `delete object ${key}`);
  }

  async listObjectKeys(prefix: string): Promise<string[]> {
    const resolvedPrefix = this.resolveKey(prefix);
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.request("GET", "", undefined, {
        "list-type": "2",
        prefix: resolvedPrefix,
        ...(continuationToken ? { "continuation-token": continuationToken } : {}),
      });
      assertOk(response.status, `list objects ${prefix}`);

      keys.push(...parseListBucketKeys(response.text));
      continuationToken = readListContinuationToken(response.text);
    } while (continuationToken);

    return keys
      .filter((key) => key.startsWith(`${this.layout.vaultPrefix}/`))
      .map((key) => key.slice(this.layout.vaultPrefix.length + 1));
  }

  private resolveKey(key: string): string {
    if (key === "manifest.json" || key.startsWith("locks/") || key.startsWith("meta/")) {
      return `${this.layout.vaultPrefix}/${key}`;
    }

    return `${this.layout.vaultPrefix}/${key}`;
  }

  private async request(method: string, key: string, body?: Uint8Array, query?: Record<string, string>): Promise<HttpResponse> {
    const url = createObjectUrl(this.options.endpoint, this.options.bucket, key, this.options.addressingStyle, query);
    const bodyBytes = body ?? new Uint8Array();
    const headers = await createSignedHeaders({
      method,
      url,
      region: this.options.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      body: bodyBytes,
      timestamp: this.options.now(),
    });

    return this.options.request({
      url,
      method,
      headers,
      body: body ? toArrayBuffer(body) : undefined,
    });
  }
}

function createObjectUrl(endpoint: string, bucket: string, key: string, addressingStyle: S3AddressingStyle, query?: Record<string, string>): string {
  const base = endpoint.replace(/\/+$/g, "");
  const search = query ? `?${new URLSearchParams(query).toString()}` : "";

  if (resolveAddressingStyle(endpoint, addressingStyle) === "virtual-hosted") {
    const url = new URL(base);
    url.hostname = `${bucket}.${url.hostname}`;
    const path = key ? encodeKey(key) : "";
    return `${url.origin}${url.pathname.replace(/\/+$/g, "")}/${path}${search}`;
  }

  const path = key ? `${encodePathPart(bucket)}/${encodeKey(key)}` : encodePathPart(bucket);
  return `${base}/${path}${search}`;
}

function resolveAddressingStyle(endpoint: string, addressingStyle: S3AddressingStyle): Exclude<S3AddressingStyle, "auto"> {
  if (addressingStyle !== "auto") {
    return addressingStyle;
  }

  const hostname = safeHostname(endpoint);

  if (hostname.endsWith(".aliyuncs.com") || hostname.endsWith(".myqcloud.com")) {
    return "virtual-hosted";
  }

  return "path";
}

function safeHostname(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodePathPart).join("/");
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

async function createSignedHeaders(input: {
  method: string;
  url: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  body: Uint8Array;
  timestamp: number;
}): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const amzDate = formatAmzDate(input.timestamp);
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = await sha256Hex(input.body);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname,
    createCanonicalQueryString(url),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(new TextEncoder().encode(canonicalRequest))].join("\n");
  const signingKey = await getSignatureKey(input.secretAccessKey, dateStamp, input.region, "s3");
  const signature = await hmacHex(signingKey, stringToSign);

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function getSignatureKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const dateKey = await hmacBytes(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = await hmacBytes(dateKey, region);
  const serviceKey = await hmacBytes(regionKey, service);
  return hmacBytes(serviceKey, "aws4_request");
}

async function hmacBytes(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const rawKey = key instanceof Uint8Array ? toArrayBuffer(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function hmacHex(key: ArrayBuffer | Uint8Array, value: string): Promise<string> {
  return hex(new Uint8Array(await hmacBytes(key, value)));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes))));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatAmzDate(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function createCanonicalQueryString(url: URL): string {
  return Array.from(url.searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseListBucketKeys(xml: string): string[] {
  return readXmlTags(xml, "Key");
}

function readListContinuationToken(xml: string): string | undefined {
  if (!/<IsTruncated>true<\/IsTruncated>/i.test(xml)) {
    return undefined;
  }

  return readXmlTags(xml, "NextContinuationToken")[0];
}

function readXmlTags(xml: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(xml)) !== null) {
    values.push(decodeXml(match[1]));
  }

  return values;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function assertOk(status: number, operation: string): void {
  if (status < 200 || status >= 300) {
    throw new Error(`Failed to ${operation}: HTTP ${status}`);
  }
}
