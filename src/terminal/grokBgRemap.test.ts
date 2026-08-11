import { describe, expect, it } from "vitest";
import { remapGrokDayCanvasToWhite } from "./grokBgRemap";

const enc = new TextEncoder();
const dec = new TextDecoder();

function map(s: string): string {
  return dec.decode(remapGrokDayCanvasToWhite(enc.encode(s)));
}

describe("remapGrokDayCanvasToWhite", () => {
  it("maps the current GrokDay #eeeeee canvas background to pure white", () => {
    expect(map("\x1b[48;2;238;238;238mhello\x1b[0m")).toBe(
      "\x1b[48;2;255;255;255mhello\x1b[0m",
    );
    expect(map("\x1b[48;2;234;234;234mscrollbar\x1b[0m")).toBe(
      "\x1b[48;2;255;255;255mscrollbar\x1b[0m",
    );
  });

  it("keeps darker user-bar grays", () => {
    // #dedede = 222 — current GrokDay dialogue bar, must stay gray.
    expect(map("\x1b[48;2;222;222;222muser\x1b[0m")).toBe(
      "\x1b[48;2;222;222;222muser\x1b[0m",
    );
  });

  it("rewrites combined SGR and colon-form backgrounds", () => {
    // Exact foreground/background ordering captured from Grok 0.2.114.
    expect(map("\x1b[38;2;68;68;68;48;2;238;238;238manswer")).toBe(
      "\x1b[38;2;68;68;68;48;2;255;255;255manswer",
    );
    expect(map("\x1b[48;2;246;246;246;38;2;40;40;40m")).toBe(
      "\x1b[48;2;255;255;255;38;2;40;40;40m",
    );
    // Grok emits this ISO-8613-6 form with an empty color-space field.
    expect(map("\x1b[48;2;;238;238;238m")).toBe(
      "\x1b[48;2;;255;255;255m",
    );
    expect(map("\x1b[48:2::238:238:238m")).toBe("\x1b[48:2::255:255:255m");
  });

  it("rewrites OSC 11 canvas gray to white", () => {
    expect(map("\x1b]11;rgb:f6f6/f6f6/f6f6\x07")).toBe(
      "\x1b]11;rgb:ffff/ffff/ffff\x07",
    );
    expect(map("\x1b]11;#f6f6f6\x1b\\")).toBe("\x1b]11;#ffffff\x1b\\");
  });

  it("leaves plain text unchanged by reference when possible", () => {
    const bytes = enc.encode("no escapes here");
    expect(remapGrokDayCanvasToWhite(bytes)).toBe(bytes);
  });
});
