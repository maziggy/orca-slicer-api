import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

/**
 * The bundle routes take the id from the URL. Express decodes %2F inside a
 * route parameter, so these run the full request path rather than the
 * service functions alone: an id that is not a bundle id must be refused
 * before it reaches the filesystem.
 */

const ORIGINAL_ENV = { ...process.env };
let scratchRoot: string;
let outside: string;

async function app(): Promise<ReturnType<typeof supertest>> {
  vi.resetModules();
  const { configureApp } = await import("../../src/index");
  return supertest(configureApp());
}

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-routes-"));
  process.env.DATA_PATH = path.join(scratchRoot, "data");
  await fs.mkdir(path.join(process.env.DATA_PATH, "bundles"), {
    recursive: true,
  });
  outside = path.join(scratchRoot, "outside");
  await fs.mkdir(path.join(outside, "sub"), { recursive: true });
  await fs.writeFile(path.join(outside, "bundle_structure.json"), "{}");
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await fs.rm(scratchRoot, { recursive: true, force: true });
});

describe("bundle routes refuse ids that are not bundle ids", () => {
  it("DELETE with an encoded path returns 400 and deletes nothing", async () => {
    const res = await (await app()).delete(
      "/profiles/bundles/..%2F..%2Foutside",
    );
    expect(res.status).toBe(400);
    await expect(fs.stat(path.join(outside, "sub"))).resolves.toBeTruthy();
  });

  it("GET with an encoded path returns 400", async () => {
    const res = await (await app()).get("/profiles/bundles/..%2F..%2Foutside");
    expect(res.status).toBe(400);
  });

  it("GET with a well-formed but unknown id is still a 404", async () => {
    const res = await (await app()).get("/profiles/bundles/0123456789abcdef");
    expect(res.status).toBe(404);
  });
});
