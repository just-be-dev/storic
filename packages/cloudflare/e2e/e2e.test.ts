/**
 * E2E test for StoricObject running in a real Durable Object via wrangler dev.
 *
 * Starts a local wrangler dev server as a subprocess, sends HTTP requests to
 * exercise all store operations through the TestDO, then tears it down.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";

let proc: Subprocess;
let baseUrl: string;

/**
 * Drain a ReadableStream, appending decoded text to `buffer` and calling
 * `onData` after each chunk. Runs in the background (never awaited by the
 * caller) so that the pipe doesn't fill up and block the child process.
 */
function drainStream(
  stream: ReadableStream<Uint8Array>,
  onData: (accumulated: string) => void,
): { getBuffer: () => string } {
  let buffer = "";
  const decoder = new TextDecoder();

  (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        onData(buffer);
      }
    } catch {
      // stream closed — expected during teardown
    }
  })();

  return { getBuffer: () => buffer };
}

/**
 * Wait for the server to actually accept a request (wrangler may print the
 * URL before the listener is fully bound).
 */
async function waitForReady(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      // Any response (even 404) means the server is up
      await resp.body?.cancel();
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`Server at ${url} did not become reachable within ${timeoutMs}ms`);
}

/**
 * Start wrangler dev as a subprocess and wait for it to print the ready URL.
 */
async function startWrangler(): Promise<{ proc: Subprocess; url: string }> {
  const child = spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "e2e/worker.ts",
      "--config",
      "e2e/wrangler.jsonc",
      "--local",
      "--port",
      "0",
    ],
    {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
      },
    },
  );

  // Wrangler prints "Ready on …" to either stdout or stderr depending on
  // version. Drain both streams and resolve as soon as either contains the URL.
  const url = await new Promise<string>((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(
          new Error(
            `Wrangler did not start within 45 seconds.\nstdout: ${stdout.getBuffer()}\nstderr: ${stderr.getBuffer()}`,
          ),
        );
      }
    }, 45_000);

    function tryResolve(buf: string) {
      if (resolved) return;
      const match = buf.match(/Ready on (http:\/\/[^\s]+)/);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    }

    const stdout = drainStream(child.stdout, tryResolve);
    const stderr = drainStream(child.stderr, tryResolve);
  });

  // Ensure the server is actually accepting connections before returning
  await waitForReady(url);

  return { proc: child, url };
}

beforeAll(async () => {
  const result = await startWrangler();
  proc = result.proc;
  baseUrl = result.url;
}, 60_000);

afterAll(async () => {
  if (proc) {
    proc.kill();
    await proc.exited;
  }
}, 10_000);

// ─── Helper ─────────────────────────────────────────────────────────────────

async function doFetch(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, init);
}

async function jsonFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const resp = await doFetch(path, init);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("StoricObject e2e", () => {
  test("save and load a PersonV1 entity", async () => {
    const saved = await jsonFetch("/save-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
      }),
    });

    expect(saved.id).toBeDefined();
    expect(saved.data._tag).toBe("Person.v1");
    expect(saved.data.firstName).toBe("Alice");
    expect(saved.data.lastName).toBe("Smith");
    expect(saved.data.email).toBe("alice@example.com");
    expect(saved.created_at).toBeNumber();
    expect(saved.updated_at).toBeNumber();
  });

  test("save PersonV1, load as PersonV2 via lens transform", async () => {
    const saved = await jsonFetch("/save-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Bob",
        lastName: "Jones",
        email: "bob@example.com",
      }),
    });

    // Load the same entity as V2
    const loaded = await jsonFetch(`/load/${saved.id}`);

    expect(loaded.id).toBe(saved.id);
    expect(loaded.data._tag).toBe("Person.v2");
    expect(loaded.data.fullName).toBe("Bob Jones");
    expect(loaded.data.email).toBe("bob@example.com");
    expect(loaded.data.age).toBe(0);
  });

  test("save PersonV2 entity directly", async () => {
    const saved = await jsonFetch("/save-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Charlie Brown",
        email: "charlie@example.com",
        age: 25,
      }),
    });

    expect(saved.data._tag).toBe("Person.v2");
    expect(saved.data.fullName).toBe("Charlie Brown");
    expect(saved.data.age).toBe(25);
  });

  test("list all entities as PersonV2", async () => {
    // Save a known entity so the list is never empty, regardless of test order
    await jsonFetch("/save-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "List Test",
        email: "list@example.com",
        age: 1,
      }),
    });

    const entities = await jsonFetch("/list");

    expect(entities.length).toBeGreaterThanOrEqual(1);
    for (const entity of entities) {
      expect(entity.data._tag).toBe("Person.v2");
      expect(entity.data.fullName).toBeDefined();
      expect(entity.data.email).toBeDefined();
      expect(typeof entity.data.age).toBe("number");
    }
  });

  test("update an entity", async () => {
    // Save a V2 entity first
    const saved = await jsonFetch("/save-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Diana Prince",
        email: "diana@example.com",
        age: 30,
      }),
    });

    // Update age
    const updated = await jsonFetch(`/update/${saved.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: 31 }),
    });

    expect(updated.data.fullName).toBe("Diana Prince");
    expect(updated.data.age).toBe(31);
    expect(updated.data.email).toBe("diana@example.com");
  });

  test("delete an entity", async () => {
    // Save an entity
    const saved = await jsonFetch("/save-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Eve Doe",
        email: "eve@example.com",
        age: 20,
      }),
    });

    // Delete it
    const deleteResult = await jsonFetch(`/delete/${saved.id}`, {
      method: "DELETE",
    });
    expect(deleteResult.deleted).toBe(true);

    // Verify it's gone — loading should 500 (EntityNotFoundError)
    const resp = await doFetch(`/load/${saved.id}`);
    expect(resp.status).toBe(500);
  });
});
