import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { AppError } from "../../middleware/error";

export interface SlicerSchema {
  /** "OrcaSlicer" or "BambuStudio", as the binary names itself. */
  slicer: string;
  /** Real binary version, e.g. "2.3.2" / "02.07.01.57" — not the image tag. */
  version: string;
  /** Every setting name this binary knows. The authoritative key list. */
  keys: string[];
  /** The binary's own default value per key. */
  defaults: Record<string, unknown>;
}

// Built once per process. The bundled slicer only changes when the image is
// rebuilt, so there is nothing to invalidate. A failed load resets the cache
// so a transient failure (slicer not yet mounted, temp dir full) can retry.
let cache: Promise<SlicerSchema> | null = null;

export function getSchema(): Promise<SlicerSchema> {
  if (!cache) {
    cache = loadSchema().catch((err) => {
      cache = null;
      throw err;
    });
  }
  return cache;
}

async function loadSchema(): Promise<SlicerSchema> {
  const slicerPath = process.env.ORCASLICER_PATH;
  if (!slicerPath) {
    throw new AppError(
      500,
      "Slicing is not configured properly on the server",
      "ORCASLICER_PATH environment variable is not defined",
    );
  }

  // The BambuStudio AppImage's own libraries (libavcodec.so.61 and friends)
  // live next to the binary and are not on the system loader path. AppRun
  // exports this itself, but a deployment pointing ORCASLICER_PATH straight
  // at squashfs-root/bin/bambu-studio would otherwise die with
  // "error while loading shared libraries". Harmless for OrcaSlicer.
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [
      path.join(path.dirname(slicerPath), "bin"),
      process.env.LD_LIBRARY_PATH,
    ]
      .filter(Boolean)
      .join(":"),
  };

  // --export-settings writes every known setting with its current value.
  // No input model is required. The CLI also drops a result.json in its
  // working directory, so run it inside the temp dir and take both away.
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "schema-"));
  try {
    const { slicer, version } = parseSlicerVersion(
      await run(slicerPath, ["--help"], env, workdir),
    );
    const outPath = path.join(workdir, "settings.json");
    await run(slicerPath, ["--export-settings", outPath], env, workdir);
    const defaults = JSON.parse(await fs.readFile(outPath, "utf-8")) as Record<
      string,
      unknown
    >;
    return { slicer, version, keys: Object.keys(defaults).sort(), defaults };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      503,
      "Failed to read the slicer's setting schema",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

/**
 * Both CLIs announce themselves on the first non-log line of `--help`:
 * "OrcaSlicer-2.3.2:" / "BambuStudio-02.07.01.57:". BambuStudio prefixes
 * that with boost trace lines, so match anywhere in the output.
 */
export function parseSlicerVersion(helpOutput: string): {
  slicer: string;
  version: string;
} {
  const match = helpOutput.match(/(OrcaSlicer|BambuStudio)-([\d.]+)/);
  if (!match) {
    throw new AppError(
      503,
      "Could not determine the slicer version",
      `Unrecognised --help output: ${helpOutput.slice(0, 200)}`,
    );
  }
  return { slicer: match[1], version: match[2] };
}

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env, cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${err.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
