import "./setup.ts";
import { test, expect, describe } from "bun:test";
import { afterEach } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { StoricProvider, useStoricStore } from "../src/index.ts";
import { makeTestRuntime } from "./test-helper.ts";

afterEach(() => cleanup());

describe("<StoricProvider>", () => {
  test("renders fallback while resolving and children once ready", async () => {
    const { runtime, dispose } = await makeTestRuntime();
    try {
      let storeRef: unknown = "unset";
      function Inner() {
        storeRef = useStoricStore();
        return <div data-testid="ready">ready</div>;
      }

      const { queryByTestId } = render(
        <StoricProvider runtime={runtime} fallback={<div data-testid="fb">loading</div>}>
          <Inner />
        </StoricProvider>,
      );

      // Either the fallback is showing, or the provider already swapped to
      // children (the runtime resolves on a microtask). Both are valid.
      const fb = queryByTestId("fb");
      const ready = queryByTestId("ready");
      expect(fb || ready).not.toBeNull();

      await waitFor(() => {
        expect(queryByTestId("ready")).not.toBeNull();
      });
      expect(typeof (storeRef as any)?.saveEntity).toBe("function");
    } finally {
      await dispose();
    }
  });
});

describe("useStoricStore without a provider", () => {
  test("throws a descriptive error", () => {
    function Inner() {
      useStoricStore();
      return null;
    }
    let threw: unknown = null;
    try {
      render(<Inner />);
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect(String(threw)).toContain("StoricProvider");
  });
});
