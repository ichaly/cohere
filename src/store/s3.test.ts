import { describe, expect, test } from "vitest";
import { createEmptyManifest } from "../sync/engine";
import { S3ObjectStore, type HttpRequest } from "./s3";

describe("S3ObjectStore", () => {
  test("returns an empty manifest when manifest object does not exist", async () => {
    const store = createStore(async () => ({
      status: 404,
      text: "",
      arrayBuffer: new ArrayBuffer(0),
    }));

    await expect(store.readManifest()).resolves.toEqual(createEmptyManifest());
  });

  test("writes objects under the vault prefix with SigV4 authorization", async () => {
    const requests: HttpRequest[] = [];
    const store = createStore(async (request) => {
      requests.push(request);
      return {
        status: 200,
        text: "",
        arrayBuffer: new ArrayBuffer(0),
      };
    });

    await store.writeObject("files/notes/today.md", new TextEncoder().encode("hello"));

    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("https://s3.example.com/my-bucket/cohere/v1/vaults/vlt_TEST/files/notes/today.md");
    expect(requests[0]?.headers.Authorization).toContain("AWS4-HMAC-SHA256");
    expect(requests[0]?.headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
  });

  test("deletes objects under the vault prefix", async () => {
    const requests: HttpRequest[] = [];
    const store = createStore(async (request) => {
      requests.push(request);
      return {
        status: 204,
        text: "",
        arrayBuffer: new ArrayBuffer(0),
      };
    });

    await store.deleteObject("files/notes/today.md");

    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe("https://s3.example.com/my-bucket/cohere/v1/vaults/vlt_TEST/files/notes/today.md");
  });

  test("lists object keys under the vault prefix", async () => {
    const requests: HttpRequest[] = [];
    const store = createStore(async (request) => {
      requests.push(request);
      return {
        status: 200,
        text: [
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
          "<ListBucketResult>",
          "<Contents><Key>cohere/v1/vaults/vlt_TEST/blobs/sha256/aa/bb/hash1</Key></Contents>",
          "<Contents><Key>cohere/v1/vaults/vlt_TEST/blobs/sha256/cc/dd/hash2</Key></Contents>",
          "</ListBucketResult>",
        ].join(""),
        arrayBuffer: new ArrayBuffer(0),
      };
    });

    await expect(store.listObjectKeys("blobs/sha256/")).resolves.toEqual([
      "blobs/sha256/aa/bb/hash1",
      "blobs/sha256/cc/dd/hash2",
    ]);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      "https://s3.example.com/my-bucket?list-type=2&prefix=cohere%2Fv1%2Fvaults%2Fvlt_TEST%2Fblobs%2Fsha256%2F",
    );
  });

  test("lists object keys across paginated responses", async () => {
    const requests: HttpRequest[] = [];
    const responses = [
      [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>true</IsTruncated>",
        "<NextContinuationToken>page 2</NextContinuationToken>",
        "<Contents><Key>cohere/v1/vaults/vlt_TEST/blobs/sha256/aa/bb/hash1</Key></Contents>",
        "</ListBucketResult>",
      ].join(""),
      [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        "<Contents><Key>cohere/v1/vaults/vlt_TEST/blobs/sha256/cc/dd/hash2</Key></Contents>",
        "</ListBucketResult>",
      ].join(""),
    ];
    const store = createStore(async (request) => {
      requests.push(request);
      return {
        status: 200,
        text: responses.shift() ?? "",
        arrayBuffer: new ArrayBuffer(0),
      };
    });

    await expect(store.listObjectKeys("blobs/sha256/")).resolves.toEqual([
      "blobs/sha256/aa/bb/hash1",
      "blobs/sha256/cc/dd/hash2",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toContain("continuation-token=page+2");
  });

  test("uses virtual-hosted style automatically for Aliyun OSS endpoints", async () => {
    const requests: HttpRequest[] = [];
    const store = createStore(async (request) => {
      requests.push(request);
      return {
        status: 200,
        text: "",
        arrayBuffer: new ArrayBuffer(0),
      };
    }, {
      endpoint: "https://oss-cn-beijing.aliyuncs.com",
      bucket: "cohere-test",
      region: "oss-cn-beijing",
    });

    await store.writeObject("files/notes/today.md", new TextEncoder().encode("hello"));

    expect(requests[0]?.url).toBe("https://cohere-test.oss-cn-beijing.aliyuncs.com/cohere/v1/vaults/vlt_TEST/files/notes/today.md");
  });

  test("can force path style addressing", async () => {
    const requests: HttpRequest[] = [];
    const store = createStore(async (request) => {
      requests.push(request);
      return {
        status: 200,
        text: "",
        arrayBuffer: new ArrayBuffer(0),
      };
    }, {
      addressingStyle: "path",
      endpoint: "https://oss-cn-beijing.aliyuncs.com",
      bucket: "cohere-test",
    });

    await store.writeObject("files/notes/today.md", new TextEncoder().encode("hello"));

    expect(requests[0]?.url).toBe("https://oss-cn-beijing.aliyuncs.com/cohere-test/cohere/v1/vaults/vlt_TEST/files/notes/today.md");
  });

  test("can force virtual-hosted style addressing", async () => {
    const requests: HttpRequest[] = [];
    const store = createStore(async (request) => {
      requests.push(request);
      return {
        status: 200,
        text: "",
        arrayBuffer: new ArrayBuffer(0),
      };
    }, {
      addressingStyle: "virtual-hosted",
      endpoint: "https://s3.example.com",
      bucket: "cohere-test",
    });

    await store.writeObject("files/notes/today.md", new TextEncoder().encode("hello"));

    expect(requests[0]?.url).toBe("https://cohere-test.s3.example.com/cohere/v1/vaults/vlt_TEST/files/notes/today.md");
  });

  test("retries transient request failures", async () => {
    let attempts = 0;
    const store = createStore(async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("net::ERR_CONNECTION_TIMED_OUT");
      }

      return {
        status: 200,
        text: "",
        arrayBuffer: new ArrayBuffer(0),
      };
    });

    await expect(store.writeObject("files/notes/today.md", new TextEncoder().encode("hello"))).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});

function createStore(
  request: (request: HttpRequest) => Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }>,
  options: Partial<ConstructorParameters<typeof S3ObjectStore>[0]> = {},
) {
  return new S3ObjectStore({
    endpoint: "https://s3.example.com",
    bucket: "my-bucket",
    addressingStyle: "auto",
    region: "auto",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "SECRET_TEST",
    rootPrefix: "cohere/v1",
    vaultId: "vlt_TEST",
    deviceId: "dev_TEST",
    now: () => 1000,
    request,
    ...options,
  });
}
