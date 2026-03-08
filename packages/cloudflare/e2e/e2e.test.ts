/**
 * E2E tests for CloudflareJsEvaluator using a real wrangler dev server.
 *
 * These tests start a local wrangler dev instance, send evaluation requests
 * to the e2e test worker, and verify the results.
 *
 * Run with: bun test e2e/e2e.test.ts
 * (from packages/cloudflare/)
 *
 * Requires wrangler to be installed (devDependency).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Subprocess } from "bun";

const PORT = 8799;
const BASE_URL = `http://localhost:${PORT}`;

let wrangler: Subprocess;

async function waitForServer(
  url: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

async function evaluate(
  jsExpr: string,
  bindings: Record<string, unknown> = {},
): Promise<{ result?: unknown; error?: string; status: number }> {
  const res = await fetch(`${BASE_URL}/eval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsExpr, bindings }),
  });
  const body = await res.json();
  return { ...body, status: res.status };
}

beforeAll(async () => {
  wrangler = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "--config",
      "wrangler.toml",
      "--port",
      String(PORT),
    ],
    {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  await waitForServer(`${BASE_URL}/health`);
}, 60_000);

afterAll(() => {
  if (wrangler) {
    wrangler.kill();
  }
});

describe("CloudflareJsEvaluator e2e", () => {
  test(
    "arithmetic expression without bindings",
    async () => {
      const res = await evaluate("2 + 3 * 4");
      expect(res.status).toBe(200);
      expect(res.result).toBe(14);
    },
    15_000,
  );

  test(
    "expression with bindings",
    async () => {
      const res = await evaluate("x + y", { x: 10, y: 20 });
      expect(res.status).toBe(200);
      expect(res.result).toBe(30);
    },
    15_000,
  );

  test(
    "string concatenation with bindings",
    async () => {
      const res = await evaluate("greeting + ' ' + name", {
        greeting: "Hello",
        name: "World",
      });
      expect(res.status).toBe(200);
      expect(res.result).toBe("Hello World");
    },
    15_000,
  );

  test(
    "object literal expression",
    async () => {
      const res = await evaluate("({ sum: a + b, product: a * b })", {
        a: 3,
        b: 7,
      });
      expect(res.status).toBe(200);
      expect(res.result).toEqual({ sum: 10, product: 21 });
    },
    15_000,
  );

  test(
    "arrow function expression returns empty object (not JSON-serializable)",
    async () => {
      // An arrow function like `(data) => data.x` evaluates to a function.
      // Functions are not JSON-serializable, so Response.json produces a
      // serialization error.
      const res = await evaluate("(data) => data.x");
      expect(res.status).toBe(400);
      expect(res.error).toContain("not JSON-serializable");
    },
    15_000,
  );

  test(
    "runtime error in expression",
    async () => {
      const res = await evaluate("x.toString()", {});
      expect(res.status).toBe(400);
      expect(res.error).toBeDefined();
      // Should contain some error information
      expect(typeof res.error).toBe("string");
      expect(res.error!.length).toBeGreaterThan(0);
    },
    15_000,
  );

  test(
    "array manipulation",
    async () => {
      const res = await evaluate("items.map(x => x * 2)", {
        items: [1, 2, 3, 4],
      });
      expect(res.status).toBe(200);
      expect(res.result).toEqual([2, 4, 6, 8]);
    },
    15_000,
  );

  test(
    "nested object bindings",
    async () => {
      const res = await evaluate("data.user.name + ' is ' + data.user.age", {
        data: { user: { name: "Alice", age: 30 } },
      });
      expect(res.status).toBe(200);
      expect(res.result).toBe("Alice is 30");
    },
    15_000,
  );
});
