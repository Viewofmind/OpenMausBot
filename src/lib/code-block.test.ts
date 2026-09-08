import { describe, expect, it } from "vitest";

import {
  countLines,
  formatLineCount,
  getCodeFileExtension,
  getLanguageDisplayName,
  getSnippetFileName,
} from "./code-block";

describe("getLanguageDisplayName", () => {
  it("maps common programming language identifiers to clean names", () => {
    expect(getLanguageDisplayName("ts")).toBe("TypeScript");
    expect(getLanguageDisplayName("typescript")).toBe("TypeScript");
    expect(getLanguageDisplayName("tsx")).toBe("TypeScript (TSX)");
    expect(getLanguageDisplayName("js")).toBe("JavaScript");
    expect(getLanguageDisplayName("jsx")).toBe("JavaScript (JSX)");
    expect(getLanguageDisplayName("py")).toBe("Python");
    expect(getLanguageDisplayName("python")).toBe("Python");
    expect(getLanguageDisplayName("sh")).toBe("Bash");
    expect(getLanguageDisplayName("bash")).toBe("Bash");
    expect(getLanguageDisplayName("zsh")).toBe("Bash");
    expect(getLanguageDisplayName("json")).toBe("JSON");
    expect(getLanguageDisplayName("rs")).toBe("Rust");
    expect(getLanguageDisplayName("rust")).toBe("Rust");
    expect(getLanguageDisplayName("go")).toBe("Go");
    expect(getLanguageDisplayName("sql")).toBe("SQL");
    expect(getLanguageDisplayName("dockerfile")).toBe("Dockerfile");
  });

  it("normalizes case and leading/trailing whitespace", () => {
    expect(getLanguageDisplayName("  PYTHON  ")).toBe("Python");
    expect(getLanguageDisplayName("TS")).toBe("TypeScript");
    expect(getLanguageDisplayName("  c++ ")).toBe("C++");
  });

  it("returns 'Code' when language is omitted or empty", () => {
    expect(getLanguageDisplayName("")).toBe("Code");
    expect(getLanguageDisplayName("   ")).toBe("Code");
    expect(getLanguageDisplayName(null)).toBe("Code");
    expect(getLanguageDisplayName(undefined)).toBe("Code");
  });

  it("gracefully capitalizes unrecognized language identifiers", () => {
    expect(getLanguageDisplayName("zig")).toBe("Zig");
    expect(getLanguageDisplayName("elixir")).toBe("Elixir");
    expect(getLanguageDisplayName("solidity")).toBe("Solidity");
  });
});

describe("countLines", () => {
  it("returns 0 for empty or omitted input", () => {
    expect(countLines("")).toBe(0);
    expect(countLines(null)).toBe(0);
    expect(countLines(undefined)).toBe(0);
  });

  it("counts single line snippets accurately", () => {
    expect(countLines("const x = 10;")).toBe(1);
    expect(countLines(" ")).toBe(1);
  });

  it("keeps deliberate trailing blank lines after Markdown's newline is removed", () => {
    expect(countLines("const x = 10;\n")).toBe(2);
    expect(countLines("const x = 10;\r\n")).toBe(2);
    expect(countLines("\n")).toBe(2);
    expect(countLines("\n\n")).toBe(3);
  });

  it("counts multi-line snippets accurately", () => {
    expect(countLines("line 1\nline 2")).toBe(2);
    expect(countLines("line 1\nline 2\n")).toBe(3);
    expect(countLines("line 1\nline 2\nline 3\n")).toBe(4);
  });

  it("supports Windows CRLF newlines", () => {
    expect(countLines("line 1\r\nline 2\r\nline 3")).toBe(3);
    expect(countLines("line 1\r\nline 2\r\nline 3\r\n")).toBe(4);
    expect(countLines("line 1\rline 2\rline 3")).toBe(3);
  });
});

describe("formatLineCount", () => {
  it("formats singular line count correctly", () => {
    expect(formatLineCount(1)).toBe("1 line");
  });

  it("formats plural line counts correctly", () => {
    expect(formatLineCount(0)).toBe("0 lines");
    expect(formatLineCount(2)).toBe("2 lines");
    expect(formatLineCount(42)).toBe("42 lines");
  });
});

describe("getCodeFileExtension", () => {
  it("maps common language identifiers to their standard file extensions", () => {
    expect(getCodeFileExtension("ts")).toBe("ts");
    expect(getCodeFileExtension("typescript")).toBe("ts");
    expect(getCodeFileExtension("tsx")).toBe("tsx");
    expect(getCodeFileExtension("js")).toBe("js");
    expect(getCodeFileExtension("jsx")).toBe("jsx");
    expect(getCodeFileExtension("py")).toBe("py");
    expect(getCodeFileExtension("python")).toBe("py");
    expect(getCodeFileExtension("sh")).toBe("sh");
    expect(getCodeFileExtension("bash")).toBe("sh");
    expect(getCodeFileExtension("zsh")).toBe("zsh");
    expect(getCodeFileExtension("json")).toBe("json");
    expect(getCodeFileExtension("sql")).toBe("sql");
    expect(getCodeFileExtension("rs")).toBe("rs");
    expect(getCodeFileExtension("rust")).toBe("rs");
    expect(getCodeFileExtension("go")).toBe("go");
    expect(getCodeFileExtension("html")).toBe("html");
    expect(getCodeFileExtension("css")).toBe("css");
    expect(getCodeFileExtension("md")).toBe("md");
    expect(getCodeFileExtension("markdown")).toBe("md");
    expect(getCodeFileExtension("yaml")).toBe("yaml");
    expect(getCodeFileExtension("yml")).toBe("yaml");
    expect(getCodeFileExtension("dockerfile")).toBe("dockerfile");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(getCodeFileExtension("  PYTHON  ")).toBe("py");
    expect(getCodeFileExtension("TS")).toBe("ts");
    expect(getCodeFileExtension(" JSON ")).toBe("json");
  });

  it("falls back to 'txt' for omitted, empty, or unknown long identifiers", () => {
    expect(getCodeFileExtension("")).toBe("txt");
    expect(getCodeFileExtension("   ")).toBe("txt");
    expect(getCodeFileExtension(null)).toBe("txt");
    expect(getCodeFileExtension(undefined)).toBe("txt");
  });

  it("uses valid short alphanumeric identifiers directly as extension", () => {
    expect(getCodeFileExtension("zig")).toBe("zig");
    expect(getCodeFileExtension("lua")).toBe("lua");
    expect(getCodeFileExtension("r")).toBe("r");
  });
});

describe("getSnippetFileName", () => {
  it("generates correct default filenames based on language", () => {
    expect(getSnippetFileName("python")).toBe("snippet.py");
    expect(getSnippetFileName("ts")).toBe("snippet.ts");
    expect(getSnippetFileName("json")).toBe("snippet.json");
    expect(getSnippetFileName("sql")).toBe("snippet.sql");
    expect(getSnippetFileName("")).toBe("snippet.txt");
    expect(getSnippetFileName(null)).toBe("snippet.txt");
  });

  it("preserves standalone filenames like dockerfile and makefile", () => {
    expect(getSnippetFileName("dockerfile")).toBe("dockerfile");
    expect(getSnippetFileName("makefile")).toBe("makefile");
  });
});

