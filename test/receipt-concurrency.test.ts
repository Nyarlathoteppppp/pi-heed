import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setup, toolCall } from "./harness.ts";

describe("test receipts and concurrent writes", () => {
    for (const command of ["uv run pytest", "npx vitest run"]) {
        it(`requires a successful ${command} result before pushing`, async () => {
            const { pi } = setup({ judge: null, env: { PI_HEED_MODE: "enforce" } });
            await pi.user("Run tests before pushing.");
            for (const isError of [true, false]) {
                const test = toolCall("bash", { command });
                await pi.emit("tool_call", test);
                await pi.emit("tool_result", { ...test, isError, content: [] });
                const push = await pi.emit("tool_call", toolCall("bash", { command: "git push" }));
                assert.equal(push?.block ?? false, isError);
            }
        });
    }
    it("a failed rerun invalidates an earlier passing test on the same revision", async () => {
        const { pi } = setup({ judge: null, env: { PI_HEED_MODE: "enforce" } });
        await pi.user("Run tests before pushing.");
        for (const isError of [false, true]) {
            const test = toolCall("bash", { command: "npm test" });
            await pi.emit("tool_call", test);
            await pi.emit("tool_result", { ...test, isError, content: [] });
        }
        assert.equal((await pi.emit("tool_call", toolCall("bash", { command: "git push" })))?.block, true);
    });
    it("a failed or masked test command cannot authorize a protected push", async () => {
        const { pi } = setup({ judge: null, env: { PI_HEED_MODE: "enforce" } });
        await pi.user("Run tests before pushing.");
        for (const command of ['echo "npm test"', "npm test || true", "uv run pytest --collect-only", "npx vitest list", "npx vitest run || true"]) {
            const event = toolCall("bash", { command });
            await pi.emit("tool_call", event);
            await pi.emit("tool_result", { ...event, content: [{ type: "text", text: "ok" }], isError: false });
            assert.equal((await pi.emit("tool_call", toolCall("bash", { command: "git push" })))?.block, true);
        }
    });
    it("a write overlapping a test invalidates the test receipt", async () => {
        const { pi } = setup({ judge: null, env: { PI_HEED_MODE: "enforce" } });
        await pi.user("Run tests before pushing.");
        const test = toolCall("bash", { command: "npm test" });
        const write = toolCall("edit", { path: "src/a.ts" });
        await pi.emit("tool_call", test);
        await pi.emit("tool_call", write);
        await pi.emit("tool_result", { ...test, isError: false, content: [] });
        assert.equal((await pi.emit("tool_call", toolCall("bash", { command: "git push" })))?.block, true);
        await pi.emit("tool_result", { ...write, isError: false, content: [] });
        const clean = toolCall("bash", { command: "npm test" });
        await pi.emit("tool_call", clean);
        await pi.emit("tool_result", { ...clean, isError: false, content: [] });
        assert.equal((await pi.emit("tool_call", toolCall("bash", { command: "git push" })))?.block ?? false, false);
    });
    it("a failed mutating tool invalidates an earlier test receipt", async () => {
        const { pi } = setup({ judge: null, env: { PI_HEED_MODE: "enforce" } });
        await pi.user("Run tests before pushing.");
        const test = toolCall("bash", { command: "npm test" });
        await pi.emit("tool_call", test);
        await pi.emit("tool_result", { ...test, isError: false, content: [] });
        const edit = toolCall("edit", { path: "src/a.ts" });
        await pi.emit("tool_call", edit);
        await pi.emit("tool_result", { ...edit, isError: true, content: [] });
        assert.equal((await pi.emit("tool_call", toolCall("bash", { command: "git push" })))?.block, true);
    });
});
