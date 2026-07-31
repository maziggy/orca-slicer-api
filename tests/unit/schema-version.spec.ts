import { describe, it, expect } from "vitest";
import { parseSlicerVersion } from "../../src/routes/schema/schema.service";

// Real first lines of `--help` from both images. BambuStudio prefixes its
// output with boost trace lines, which is the whole reason this isn't a
// startsWith check.
const ORCA_HELP = `OrcaSlicer-2.3.2:
Usage: orca-slicer [ OPTIONS ] [ file.3mf/file.stl ... ]`;

const BAMBU_HELP = `[2026-07-31 20:57:01.505970] [0x00007ffff183c500] [trace]   Initializing StaticPrintConfigs
BambuStudio-02.07.01.57:
Usage: bambu-studio [ OPTIONS ] [ file.3mf/file.stl ... ]`;

describe("parseSlicerVersion", () => {
  it("reads the OrcaSlicer version", () => {
    expect(parseSlicerVersion(ORCA_HELP)).toEqual({
      slicer: "OrcaSlicer",
      version: "2.3.2",
    });
  });

  it("reads the BambuStudio version past the trace prefix, keeping leading zeros", () => {
    expect(parseSlicerVersion(BAMBU_HELP)).toEqual({
      slicer: "BambuStudio",
      version: "02.07.01.57",
    });
  });

  it("throws when the output names no known slicer", () => {
    expect(() => parseSlicerVersion("command not found")).toThrow();
  });
});
