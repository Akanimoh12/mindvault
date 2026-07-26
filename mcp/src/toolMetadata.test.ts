/**
 * Snapshot tests for MCP tool metadata (the ListTools response).
 *
 * The definitions are imported from `tools.ts` — the same array the server
 * hands to agent clients — so a change to a description, example, or schema
 * shows up here instead of drifting silently. `tools.ts` has no side effects,
 * so importing it never boots the server or its stdio transport.
 */
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./tools.js";

function toolNamed(name: string) {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} is not defined`);
  return tool;
}

describe("MCP tool metadata", () => {
  it("all tools have required fields", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^mindvault_[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTypeOf("object");
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  it("every required argument is declared in properties", () => {
    for (const tool of TOOL_DEFINITIONS) {
      for (const required of tool.inputSchema.required) {
        expect(
          Object.keys(tool.inputSchema.properties),
          `${tool.name}.${required} is required but not declared`,
        ).toContain(required);
      }
    }
  });

  it("tool names are unique", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exposes the expected tool surface", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toMatchSnapshot();
  });

  it("mindvault_search inputSchema", () => {
    expect(toolNamed("mindvault_search").inputSchema).toMatchSnapshot();
  });

  it("mindvault_publish inputSchema", () => {
    expect(toolNamed("mindvault_publish").inputSchema).toMatchSnapshot();
  });
});
