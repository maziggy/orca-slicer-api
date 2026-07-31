import { describe, expect, it } from "vitest";
import { request } from "./setup";

// Key counts are per slicer *and* per version (545 on BambuStudio 02.07,
// 572 on OrcaSlicer 2.3.2), and the e2e matrix builds several versions, so
// this asserts the shape and a floor rather than an exact number that would
// break on every slicer bump.
describe("GET /schema", () => {
  it("reports the bundled slicer's real version and key set", async () => {
    const response = await request.get("/schema").expect(200);
    const { slicer, version, keys, defaults } = response.body;

    expect(["OrcaSlicer", "BambuStudio"]).toContain(slicer);
    expect(version).toMatch(/^\d[\d.]*$/);
    expect(keys.length).toBeGreaterThan(400);
    // Present on both slicers — if these are missing, the export was truncated.
    expect(keys).toContain("layer_height");
    expect(keys).toContain("sparse_infill_density");
    expect(Object.keys(defaults)).toHaveLength(keys.length);
    expect(defaults.layer_height).toBeDefined();
  }, 120_000);

  it("serves the cached result on repeat calls", async () => {
    const first = await request.get("/schema").expect(200);
    const second = await request.get("/schema").expect(200);
    expect(second.body).toEqual(first.body);
  }, 120_000);
});
