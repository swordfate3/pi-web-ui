import assert from "node:assert/strict";
import { test } from "node:test";
import { setLanguage, workspaceUploadText } from "../src/web/src/core/i18n";
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  MAX_WORKSPACE_UPLOAD_FILES,
  uploadWorkspaceFiles,
  workspaceUploadUrl,
} from "../src/web/src/core/workspace-uploads";

const ORIGIN = "https://pi.example";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const SCOPE = { sessionId: "session_1", runtimeId: "runtime_1", generation: "/s/0123456789abcdef0123456789abcdef/" };

type TestFile = Blob & { name: string; lastModified: number };
function file(name: string, size: number, type = "application/octet-stream"): TestFile {
  return Object.assign(new Blob([new Uint8Array(size)], { type }), { name, lastModified: 1 });
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
      this.responseText = JSON.stringify({
        uploadId: UUID,
        relativePath: `.pi-uploads/${SCOPE.sessionId}/${UUID}/${(body as TestFile).name}`,
        filename: (body as TestFile).name,
        size: (body as Blob).size,
      });
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
  return {
    scope: SCOPE,
    origin: ORIGIN,
    pathname: SCOPE.generation,
    signal,
    send,
    xhrFactory,
  };
}

test("resolves UUID upload endpoint under current Hub generation and reverse-proxy root", () => {
  assert.equal(
    workspaceUploadUrl(`/api/uploads/${UUID}`, ORIGIN, SCOPE.generation),
    `${ORIGIN}${SCOPE.generation}api/uploads/${UUID}`,
  );
  assert.equal(workspaceUploadUrl(`/api/uploads/${UUID}`, ORIGIN, "/prefix/"), `${ORIGIN}/prefix/api/uploads/${UUID}`);
  for (const unsafe of [
    `https://attacker.invalid/api/uploads/${UUID}`,
    `//attacker.invalid/api/uploads/${UUID}`,
    "/api/other",
    `/api/uploads/${UUID}?other=1`,
    "/../../api/uploads/123",
  ]) {
    assert.throws(() => workspaceUploadUrl(unsafe, ORIGIN, SCOPE.generation));
  }
});

test("uploads original mixed attachment bytes via sequential raw PUT, returns opaque receipts", async () => {
  const text = file("资料.txt", 8, "text/plain");
  const png = file("image.png", 12, "image/png");
  const large = file("large.bin", 17 * 1024 * 1024);
  const files = [text, png, large].map((value, index) => ({ id: `file-${index}`, file: value as unknown as File }));
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const requests: FakeXhr[] = [];
  let active = 0;
  let maxActive = 0;
  const receipts = await uploadWorkspaceFiles(
    files,
    uploadOptions(
      async (method, params) => {
        calls.push({ method, params });
        return {
          uploadId: UUID,
          url: `/api/uploads/${UUID}`,
          relativePath: `.pi-uploads/${SCOPE.sessionId}/${UUID}/${params?.filename}`,
          maxBytes: MAX_WORKSPACE_UPLOAD_BYTES,
        };
      },
      (() => {
        const xhr = new FakeXhr();
        const originalSend = xhr.send.bind(xhr);
        xhr.send = (body) => {
          active++;
          maxActive = Math.max(active, maxActive);
          requests.push(xhr);
          originalSend(body);
          active--;
        };
        return xhr as unknown as XMLHttpRequest;
      }) as () => XMLHttpRequest,
    ),
  );

  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ method }) => method === "prepare_upload"));
  assert.deepEqual(calls[0].params, {
    filename: "资料.txt",
    size: text.size,
    sessionId: SCOPE.sessionId,
    runtimeId: SCOPE.runtimeId,
  });
  assert.ok(calls.every(({ params }) => !params || (!("file" in params) && !("path" in params))));
  assert.equal(maxActive, 1);
  assert.deepEqual(
    requests.map((xhr) => xhr.opened?.method),
    ["PUT", "PUT", "PUT"],
  );
  assert.deepEqual(
    requests.map((xhr) => xhr.opened?.url),
    Array(3).fill(`${ORIGIN}${SCOPE.generation}api/uploads/${UUID}`),
  );
  assert.ok(requests.every((xhr) => xhr.headers["Content-Type"] === "application/octet-stream"));
  assert.equal(requests[2].body, large);
  assert.equal((requests[2].body as Blob).size, 17 * 1024 * 1024);
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts[0], {
    uploadId: UUID,
    relativePath: `.pi-uploads/${SCOPE.sessionId}/${UUID}/资料.txt`,
    filename: "资料.txt",
    size: text.size,
  });
});

test("allows an empty file and rejects a file over 50 MiB or more than five files before prepare", async () => {
  let prepareCount = 0;
  const send = async () => {
    prepareCount++;
    return {
      uploadId: UUID,
      url: `/api/uploads/${UUID}`,
      relativePath: `.pi-uploads/${SCOPE.sessionId}/${UUID}/empty.txt`,
      maxBytes: MAX_WORKSPACE_UPLOAD_BYTES,
    };
  };
  const xhr = new FakeXhr();
  const [emptyReceipt] = await uploadWorkspaceFiles(
    [{ id: "empty", file: file("empty.txt", 0) as unknown as File }],
    uploadOptions(send, () => xhr as unknown as XMLHttpRequest),
  );
  assert.equal(emptyReceipt.size, 0);
  assert.equal(prepareCount, 1);

  await assert.rejects(
    () =>
      uploadWorkspaceFiles(
        [{ id: "large", file: file("too-large.bin", MAX_WORKSPACE_UPLOAD_BYTES + 1) as unknown as File }],
        uploadOptions(send, () => xhr as unknown as XMLHttpRequest),
      ),
    /50 MiB/,
  );
  await assert.rejects(
    () =>
      uploadWorkspaceFiles(
        Array.from({ length: MAX_WORKSPACE_UPLOAD_FILES + 1 }, (_, index) => ({
          id: String(index),
          file: file(`${index}.bin`, 1) as unknown as File,
        })),
        uploadOptions(send, () => xhr as unknown as XMLHttpRequest),
      ),
    /5 attachments/,
  );
  assert.equal(prepareCount, 1);
});

test("aborting XHR rejects and never prepares later attachments", async () => {
  const controller = new AbortController();
  const xhr = new FakeXhr();
  xhr.autoRespond = false;
  let prepareCount = 0;
  const pending = uploadWorkspaceFiles(
    [
      { id: "one", file: file("one.txt", 4) as unknown as File },
      { id: "two", file: file("two.txt", 4) as unknown as File },
    ],
    uploadOptions(
      async () => {
        prepareCount++;
        return {
          uploadId: UUID,
          url: `/api/uploads/${UUID}`,
          relativePath: `.pi-uploads/${SCOPE.sessionId}/${UUID}/one.txt`,
          maxBytes: MAX_WORKSPACE_UPLOAD_BYTES,
        };
      },
      () => xhr as unknown as XMLHttpRequest,
      controller.signal,
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(xhr.aborted, true);
  assert.equal(prepareCount, 1);
});

test("attachment progress and recovery copy interpolate in English and Chinese", () => {
  try {
    setLanguage("zh-CN");
    assert.equal(workspaceUploadText("uploadProgress", { filename: "资料.txt", progress: "50%" }), "资料.txt：50%");
    assert.equal(workspaceUploadText("savedPath", { path: ".pi-uploads/资料.txt" }), "已保存：.pi-uploads/资料.txt");
    setLanguage("en");
    assert.equal(workspaceUploadText("uploadProgress", { filename: "file.txt", progress: "50%" }), "file.txt: 50%");
    assert.match(workspaceUploadText("sizeLimit"), /50 MiB/);
  } finally {
    setLanguage("en");
  }
});

test("scope change or cancellation while prepare is pending prevents any PUT", async () => {
  for (const mode of ["scope", "cancel"]) {
    const controller = new AbortController();
    let current = true;
    let resolvePrepare: ((value: unknown) => void) | undefined;
    let xhrCount = 0;
    const pending = uploadWorkspaceFiles([{ id: "one", file: file("one.txt", 4) as unknown as File }], {
      ...uploadOptions(
        () =>
          new Promise((resolve) => {
            resolvePrepare = resolve;
          }),
        () => {
          xhrCount++;
          return new FakeXhr() as unknown as XMLHttpRequest;
        },
        controller.signal,
      ),
      isCurrent: () => current,
    });
    if (mode === "scope") current = false;
    else controller.abort();
    resolvePrepare?.({
      uploadId: UUID,
      url: `/api/uploads/${UUID}`,
      relativePath: `.pi-uploads/session/${UUID}/one.txt`,
      maxBytes: MAX_WORKSPACE_UPLOAD_BYTES,
    });
    await assert.rejects(pending);
    assert.equal(xhrCount, 0);
  }
});

test("scope change after PUT prevents receipt callbacks and later files", async () => {
  const xhr = new FakeXhr();
  xhr.autoRespond = false;
  let current = true;
  let receiptCount = 0;
  let prepares = 0;
  const pending = uploadWorkspaceFiles(
    ["one", "two"].map((id) => ({ id, file: file(`${id}.txt`, 4) as unknown as File })),
    {
      ...uploadOptions(
        async () => {
          prepares++;
          return {
            uploadId: UUID,
            url: `/api/uploads/${UUID}`,
            relativePath: `.pi-uploads/session/${UUID}/one.txt`,
            maxBytes: MAX_WORKSPACE_UPLOAD_BYTES,
          };
        },
        () => xhr as unknown as XMLHttpRequest,
      ),
      isCurrent: () => current,
      onReceipt: () => receiptCount++,
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  xhr.status = 200;
  xhr.responseText = JSON.stringify({
    uploadId: UUID,
    relativePath: `.pi-uploads/session/${UUID}/one.txt`,
    filename: "one.txt",
    size: 4,
  });
  xhr.onload?.();
  await assert.rejects(pending);
  assert.equal(receiptCount, 0);
  assert.equal(prepares, 1);
});

test("rejects malformed prepare responses and cross-scope route changes", async () => {
  const xhr = new FakeXhr();
  const base = uploadOptions(
    async () => ({
      uploadId: UUID,
      url: `/api/uploads/${UUID}`,
      relativePath: `.pi-uploads/${SCOPE.sessionId}/${UUID}/file.txt`,
      maxBytes: MAX_WORKSPACE_UPLOAD_BYTES,
    }),
    () => xhr as unknown as XMLHttpRequest,
  );
  await assert.rejects(() =>
    uploadWorkspaceFiles([{ id: "file", file: file("file.txt", 1) as unknown as File }], {
      ...base,
      send: async () => ({
        ...((await base.send("prepare_upload")) as Record<string, unknown>),
        url: "https://attacker.invalid/upload",
      }),
    }),
  );
  await assert.rejects(() =>
    uploadWorkspaceFiles([{ id: "file", file: file("file.txt", 1) as unknown as File }], {
      ...base,
      isCurrent: () => false,
    }),
  );
});
