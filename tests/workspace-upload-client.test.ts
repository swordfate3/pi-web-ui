import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setLanguage, workspaceUploadText } from "../src/web/src/core/i18n";
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  MAX_WORKSPACE_UPLOAD_FILES,
  uploadWorkspaceFiles,
  WORKSPACE_UPLOAD_CHUNK_SIZE,
  workspaceUploadUrl,
} from "../src/web/src/core/workspace-uploads";

const ORIGIN = "https://pi.example";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const SCOPE = { sessionId: "session_1", runtimeId: "runtime_1", generation: "/s/0123456789abcdef0123456789abcdef/" };
type TestFile = Blob & { name: string; lastModified: number };
function file(name: string, size: number, type = "application/octet-stream"): TestFile {
  return Object.assign(new Blob([new Uint8Array(size)], { type }), { name, lastModified: 1 });
}
function virtualFile(name: string, size: number): File {
  return { name, size, slice: () => new Blob([]) } as unknown as File;
}

class FakeXhr {
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  status = 0;
  responseText = "";
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  opened?: { method: string; url: string };
  headers: Record<string, string> = {};
  body?: unknown;
  aborted = false;
  autoRespond = true;
  open(method: string, url: string) {
    this.opened = { method, url };
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
    if (this.autoRespond) {
      this.status = 200;
      const match = this.opened?.url.match(/\/api\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/i);
      this.responseText = JSON.stringify({ uploadId: match?.[1], nextChunk: Number(match?.[2]) + 1 });
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: (body as Blob).size,
        total: (body as Blob).size,
      } as ProgressEvent);
      this.onload?.();
    }
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

function uploadOptions(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  xhrFactory: () => XMLHttpRequest,
  signal = new AbortController().signal,
) {
  return { scope: SCOPE, origin: ORIGIN, pathname: SCOPE.generation, signal, send, xhrFactory };
}
function prepared(fileName: string, _size: number, overrides: Record<string, unknown> = {}, uploadId = UUID) {
  return {
    protocol: 2,
    uploadId,
    url: `/api/uploads/${uploadId}`,
    relativePath: `.pi-uploads/${SCOPE.sessionId}/${uploadId}/${fileName}`,
    maxBytes: MAX_WORKSPACE_UPLOAD_BYTES,
    chunkSize: WORKSPACE_UPLOAD_CHUNK_SIZE,
    nextChunk: 0,
    complete: false,
    ...overrides,
  };
}

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

test("resolves UUID upload endpoint under current Hub generation and reverse-proxy root", () => {
  assert.equal(
    workspaceUploadUrl(`/api/uploads/${UUID}`, ORIGIN, SCOPE.generation),
    `${ORIGIN}${SCOPE.generation}api/uploads/${UUID}`,
  );
  assert.equal(workspaceUploadUrl(`/api/uploads/${UUID}`, ORIGIN, "/prefix/"), `${ORIGIN}/prefix/api/uploads/${UUID}`);
  const boundedPath = `/s/b2-${"a".repeat(32)}-${"0".repeat(15)}1-${"b".repeat(32)}/`;
  assert.equal(
    workspaceUploadUrl(`/api/uploads/${UUID}`, ORIGIN, boundedPath),
    `${ORIGIN}${boundedPath}api/uploads/${UUID}`,
  );
  assert.throws(() => workspaceUploadUrl(`/s/${"c".repeat(32)}/api/uploads/${UUID}`, ORIGIN, boundedPath));
  for (const unsafe of [
    `https://attacker.invalid/api/uploads/${UUID}`,
    `//attacker.invalid/api/uploads/${UUID}`,
    "/api/other",
    `/api/uploads/${UUID}?other=1`,
    "/../../api/uploads/123",
  ])
    assert.throws(() => workspaceUploadUrl(unsafe, ORIGIN, SCOPE.generation));
});

test("uploads raw 8 MiB chunks sequentially and gets the legacy receipt from complete_upload", async () => {
  const data = new Uint8Array(WORKSPACE_UPLOAD_CHUNK_SIZE + 19);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const large = Object.assign(new Blob([data]), { name: "资料.bin", lastModified: 1 }) as TestFile;
  const files = [file("empty.txt", 0), file("image.png", 12, "image/png"), large].map((value, index) => ({
    id: `file-${index}`,
    file: value as unknown as File,
  }));
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const requests: FakeXhr[] = [];
  const uploads = new Map<string, { filename: string; size: number; relativePath: string }>();
  let prepareNumber = 0;
  const receipts = await uploadWorkspaceFiles(
    files,
    uploadOptions(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "prepare_upload") {
          const uploadId = `123e4567-e89b-42d3-a456-${String(426614174000 + prepareNumber++).padStart(12, "0")}`;
          const item = prepared(String(params?.filename), Number(params?.size), {}, uploadId);
          uploads.set(uploadId, {
            filename: String(params?.filename),
            size: Number(params?.size),
            relativePath: item.relativePath,
          });
          return item;
        }
        assert.equal(method, "complete_upload");
        const item = uploads.get(String(params?.uploadId));
        assert.ok(item);
        return { uploadId: params?.uploadId, ...item };
      },
      (() => {
        const xhr = new FakeXhr();
        requests.push(xhr);
        return xhr as unknown as XMLHttpRequest;
      }) as () => XMLHttpRequest,
    ),
  );

  assert.deepEqual(
    calls.filter(({ method }) => method === "prepare_upload").map(({ params }) => params?.protocol),
    [2, 2, 2],
  );
  assert.equal(calls.filter(({ method }) => method === "complete_upload").length, 3);
  const largePrepare = calls.find(({ params }) => params?.filename === "资料.bin")?.params;
  assert.equal(largePrepare?.size, data.length);
  assert.equal(largePrepare?.sha256, sha(data));
  assert.deepEqual(largePrepare?.chunkHashes, [
    sha(data.subarray(0, WORKSPACE_UPLOAD_CHUNK_SIZE)),
    sha(data.subarray(WORKSPACE_UPLOAD_CHUNK_SIZE)),
  ]);
  assert.deepEqual(
    requests.map((xhr) => (xhr.body as Blob).size),
    [12, WORKSPACE_UPLOAD_CHUNK_SIZE, 19],
  );
  assert.deepEqual(
    requests.map((xhr) => xhr.opened?.url.match(/\/chunks\/(\d+)$/)?.[1]),
    ["0", "0", "1"],
  );
  assert.ok(
    requests.every((xhr) =>
      /^\/s\/[a-f0-9]{32}\/api\/uploads\/[0-9a-f-]{36}\/chunks\/\d+$/i.test(
        new URL(xhr.opened?.url ?? ORIGIN).pathname,
      ),
    ),
  );
  assert.ok(requests.every((xhr) => xhr.opened?.method === "PUT"));
  assert.ok(requests.every((xhr) => xhr.headers["Content-Type"] === "application/octet-stream"));
  assert.equal(receipts.length, 3);
  assert.equal(receipts[2].filename, "资料.bin");
  assert.equal(receipts[2].size, data.length);
});

test("resumes from server nextChunk and calls complete even when prepare says already complete", async () => {
  const value = file("resume.txt", 4);
  const calls: string[] = [];
  let xhrCount = 0;
  const [receipt] = await uploadWorkspaceFiles([{ id: "resume", file: value as unknown as File }], {
    ...uploadOptions(
      async (method) => {
        calls.push(method);
        if (method === "prepare_upload") return prepared("resume.txt", 4, { nextChunk: 1, complete: true });
        return {
          uploadId: UUID,
          relativePath: `.pi-uploads/${SCOPE.sessionId}/${UUID}/resume.txt`,
          filename: "resume.txt",
          size: 4,
        };
      },
      () => {
        xhrCount++;
        return new FakeXhr() as unknown as XMLHttpRequest;
      },
    ),
  });
  assert.deepEqual(calls, ["prepare_upload", "complete_upload"]);
  assert.equal(xhrCount, 0);
  assert.equal(receipt.filename, "resume.txt");
});

test("enforces 8 GiB and five files before allocating or preparing", async () => {
  let prepareCount = 0;
  const send = async () => {
    prepareCount++;
    throw new Error("must not prepare");
  };
  const xhr = () => new FakeXhr() as unknown as XMLHttpRequest;
  assert.equal(MAX_WORKSPACE_UPLOAD_BYTES, 8 * 1024 * 1024 * 1024);
  await assert.rejects(
    uploadWorkspaceFiles(
      [{ id: "too-large", file: virtualFile("too-large.bin", MAX_WORKSPACE_UPLOAD_BYTES + 1) }],
      uploadOptions(send, xhr),
    ),
    /8 GiB/,
  );
  await assert.rejects(
    uploadWorkspaceFiles(
      Array.from({ length: MAX_WORKSPACE_UPLOAD_FILES + 1 }, (_, index) => ({
        id: String(index),
        file: virtualFile(`${index}.bin`, 0),
      })),
      uploadOptions(send, xhr),
    ),
    /5 attachments/,
  );
  assert.equal(prepareCount, 0);
});

test("abort during a pending prepare returns promptly and prevents later PUT", async () => {
  const controller = new AbortController();
  let resolvePrepare!: (value: unknown) => void;
  let xhrCount = 0;
  const pending = uploadWorkspaceFiles([{ id: "one", file: file("one.txt", 4) as unknown as File }], {
    ...uploadOptions(
      () => new Promise((resolve) => (resolvePrepare = resolve)),
      () => {
        xhrCount++;
        return new FakeXhr() as unknown as XMLHttpRequest;
      },
      controller.signal,
    ),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  resolvePrepare(prepared("one.txt", 4));
  assert.equal(xhrCount, 0);
});

test("abort while hashing yields promptly and scopes are checked before sending prepare", async () => {
  const controller = new AbortController();
  let current = true;
  let prepareCount = 0;
  const value = file("hash.bin", 512 * 1024);
  const pending = uploadWorkspaceFiles([{ id: "hash", file: value as unknown as File }], {
    ...uploadOptions(
      async () => {
        prepareCount++;
        return prepared("hash.bin", value.size);
      },
      () => new FakeXhr() as unknown as XMLHttpRequest,
      controller.signal,
    ),
    isCurrent: () => current,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  current = false;
  await assert.rejects(
    uploadWorkspaceFiles([{ id: "stale", file: value as unknown as File }], {
      ...uploadOptions(
        async () => {
          prepareCount++;
          return prepared("hash.bin", value.size);
        },
        () => new FakeXhr() as unknown as XMLHttpRequest,
      ),
      isCurrent: () => current,
    }),
  );
  assert.equal(prepareCount, 0);
});

test("validates prepare, chunk ack and completion receipt shapes", async () => {
  const value = file("invalid.txt", 2) as unknown as File;
  for (const override of [
    { protocol: 1 },
    { chunkSize: 1 },
    { nextChunk: 2 },
    { complete: "yes" },
    { maxBytes: 9 * 1024 ** 3 },
  ]) {
    await assert.rejects(
      uploadWorkspaceFiles(
        [{ id: "bad", file: value }],
        uploadOptions(
          async () => prepared("invalid.txt", 2, override),
          () => new FakeXhr() as unknown as XMLHttpRequest,
        ),
      ),
    );
  }
  await assert.rejects(
    uploadWorkspaceFiles(
      [{ id: "bad-ack", file: value }],
      uploadOptions(
        async (method, params) => {
          if (method === "prepare_upload") return prepared("invalid.txt", 2);
          return { uploadId: params?.uploadId, relativePath: ".pi-uploads/wrong", filename: "invalid.txt", size: 2 };
        },
        () => {
          const xhr = new FakeXhr();
          xhr.send = (body) => {
            xhr.body = body;
            xhr.status = 200;
            xhr.responseText = JSON.stringify({ uploadId: UUID, nextChunk: 9 });
            xhr.onload?.();
          };
          return xhr as unknown as XMLHttpRequest;
        },
      ),
    ),
  );
});

test("scope change or cancellation while prepare is pending prevents PUT", async () => {
  for (const mode of ["scope", "cancel"]) {
    const controller = new AbortController();
    let current = true;
    let resolvePrepare!: (value: unknown) => void;
    let xhrCount = 0;
    const pending = uploadWorkspaceFiles([{ id: "one", file: file("one.txt", 4) as unknown as File }], {
      ...uploadOptions(
        () => new Promise((resolve) => (resolvePrepare = resolve)),
        () => {
          xhrCount++;
          return new FakeXhr() as unknown as XMLHttpRequest;
        },
        controller.signal,
      ),
      isCurrent: () => current,
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (mode === "scope") current = false;
    else controller.abort();
    resolvePrepare(prepared("one.txt", 4));
    await assert.rejects(pending);
    assert.equal(xhrCount, 0);
  }
});

test("progress and attachment messages interpolate in English and Chinese", () => {
  try {
    setLanguage("zh-CN");
    assert.equal(workspaceUploadText("uploadProgress", { filename: "资料.txt", progress: "50%" }), "资料.txt：50%");
    assert.match(workspaceUploadText("hashing"), /校验/);
    assert.match(workspaceUploadText("finalizing"), /完成/);
    assert.equal(workspaceUploadText("savedPath", { path: ".pi-uploads/资料.txt" }), "已保存：.pi-uploads/资料.txt");
    setLanguage("en");
    assert.equal(workspaceUploadText("uploadProgress", { filename: "file.txt", progress: "50%" }), "file.txt: 50%");
    assert.match(workspaceUploadText("sizeLimit"), /8 GiB/);
  } finally {
    setLanguage("en");
  }
});
