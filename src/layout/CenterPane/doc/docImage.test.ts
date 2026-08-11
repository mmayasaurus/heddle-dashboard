//! Regression tests for stripImageRatioAlt: remove Milkdown's block-image scaling ratio from alt text and emit
//! clean, standard Markdown image syntax without altering user-authored alt text or ordinary links.

import { describe, expect, it } from "vitest";
import { stripImageRatioAlt } from "./docImage";

describe("stripImageRatioAlt", () => {
  it("strips the scale ratio that block images stash in the alt text", () => {
    expect(stripImageRatioAlt("![1.00](assets/a.png)")).toBe("![](assets/a.png)");
  });

  it("keeps the title that follows the url", () => {
    expect(stripImageRatioAlt('![0.50](assets/a.png "caption")')).toBe(
      '![](assets/a.png "caption")',
    );
  });

  it("handles several images within one passage", () => {
    const src = "before\n\n![1.00](a.png)\n\nmiddle\n\n![2.50](b.png)\n\nafter";
    const out = "before\n\n![](a.png)\n\nmiddle\n\n![](b.png)\n\nafter";
    expect(stripImageRatioAlt(src)).toBe(out);
  });

  it("leaves genuine alt text written by the user alone", () => {
    expect(stripImageRatioAlt("![architecture diagram](a.png)")).toBe("![architecture diagram](a.png)");
  });

  it("strips only the two-decimal form, sparing genuine alt text that is an integer or has one decimal", () => {
    expect(stripImageRatioAlt("![3](a.png)")).toBe("![3](a.png)");
    expect(stripImageRatioAlt("![1.5](a.png)")).toBe("![1.5](a.png)");
  });

  it("touches only images ![](...) and never ordinary links [](...)", () => {
    expect(stripImageRatioAlt("[1.00](a.png)")).toBe("[1.00](a.png)");
  });

  it("returns the input unchanged when there is no image", () => {
    expect(stripImageRatioAlt("# Heading\n\nbody text")).toBe("# Heading\n\nbody text");
  });
});
