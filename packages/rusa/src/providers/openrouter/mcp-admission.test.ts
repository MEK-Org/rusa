// @vitest-environment node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { mcpAdmissionExtension } from "./mcp-admission.js";

it.each([
  "connected",
  "delayed",
  "missing",
  "empty",
])("admits only registered required MCP namespaces: %s", async (mode) => {
  const source = mcpAdmissionExtension(["inbox", "mesh"], 100);
  const program = `
    const extension = await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(source)}`)});
    let tools = ${JSON.stringify(mode === "connected" ? [{ name: "mcp__inbox__list" }, { name: "mcp__mesh__send" }] : mode === "empty" ? [] : [{ name: "mcp__inbox__list" }])};
    let callback;
    extension.default({on: (_, cb) => {callback = cb}, getAllTools: () => tools});
    ${mode === "delayed" ? 'setTimeout(() => tools.push({name: "mcp__mesh__send"}), 30);' : ""}
    await callback();
    process.stdout.write("inference-admitted");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, "close");
  const admitted = mode === "connected" || mode === "delayed";
  expect(code).toBe(admitted ? 0 : 78);
  expect(output).toBe(admitted ? "inference-admitted" : "");
});
