import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  acceptPrinterParent,
  cliPrinterPreset,
  ensureProfileType,
  printerIdentity,
  mergeProfiles,
  normalizeFromField,
  resolveProfile,
  getDefaultBundledProfilesPath,
  type ProfileJson,
} from "../../src/routes/slicing/profile-resolver";

describe("mergeProfiles", () => {
  it("child fields override parent fields key-by-key", () => {
    const parent: ProfileJson = { foo: "parent", bar: "kept" };
    const child: ProfileJson = { foo: "child" };
    const merged = mergeProfiles(parent, child);
    expect(merged.foo).toBe("child");
    expect(merged.bar).toBe("kept");
  });

  it("replaces arrays rather than concatenating them", () => {
    // OrcaSlicer's GUI applies delta profiles by replacing array-typed
    // settings wholesale, never concatenating. Mirror that or downstream
    // settings end up with double-entries.
    const parent: ProfileJson = { compatible_printers: ["A", "B", "C"] };
    const child: ProfileJson = { compatible_printers: ["X"] };
    const merged = mergeProfiles(parent, child);
    expect(merged.compatible_printers).toEqual(["X"]);
  });

  it("advances inherits to the parent's inherits, dropping the resolved name", () => {
    const parent: ProfileJson = { inherits: "fdm_root", foo: "p" };
    const child: ProfileJson = { inherits: "user_facing_name", foo: "c" };
    const merged = mergeProfiles(parent, child);
    expect(merged.inherits).toBe("fdm_root");
    expect(merged.foo).toBe("c");
  });

  it("removes inherits when the parent has none", () => {
    const parent: ProfileJson = { foo: "p" };
    const child: ProfileJson = { inherits: "anything", foo: "c" };
    const merged = mergeProfiles(parent, child);
    expect(merged.inherits).toBeUndefined();
  });
});

describe("resolveProfile", () => {
  let bundledProfilesPath: string;

  beforeAll(async () => {
    bundledProfilesPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "test-bundled-"),
    );
    await fs.mkdir(path.join(bundledProfilesPath, "machine"), {
      recursive: true,
    });

    // Three-level chain mirroring real OrcaSlicer BBL layout:
    //   "Bambu Lab X1 Carbon 0.4 nozzle" -> "fdm_bbl_3dp_001_common" -> "fdm_machine_common"
    // The resolver walks ALL the way to root because --load-settings does
    // not run the GUI's preset-registry resolver — required fields like
    // layer_change_gcode live on the deepest templates and must be baked
    // into the output for the CLI to accept it.
    await fs.writeFile(
      path.join(bundledProfilesPath, "machine", "fdm_machine_common.json"),
      JSON.stringify({
        type: "machine",
        name: "fdm_machine_common",
        layer_change_gcode: ";LAYER_CHANGE",
        gcode_flavor: "marlin",
      }),
    );

    await fs.writeFile(
      path.join(
        bundledProfilesPath,
        "machine",
        "fdm_bbl_3dp_001_common.json",
      ),
      JSON.stringify({
        type: "machine",
        name: "fdm_bbl_3dp_001_common",
        inherits: "fdm_machine_common",
        printer_technology: "FFF",
        nozzle_volume: "92",
      }),
    );

    await fs.writeFile(
      path.join(
        bundledProfilesPath,
        "machine",
        "Bambu Lab X1 Carbon 0.4 nozzle.json",
      ),
      JSON.stringify({
        type: "machine",
        name: "Bambu Lab X1 Carbon 0.4 nozzle",
        inherits: "fdm_bbl_3dp_001_common",
        instantiation: "true",
        printer_model: "Bambu Lab X1 Carbon",
        nozzle_diameter: ["0.4"],
        printer_variant: "0.4",
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(bundledProfilesPath, { recursive: true, force: true });
  });

  it("returns the input unchanged when there is no inherits field", async () => {
    const input: ProfileJson = { type: "machine", name: "flat" };
    const result = await resolveProfile(input, "machine", {
      bundledProfilesPath,
    });
    expect(result).toEqual(input);
  });

  it("walks the full chain and bakes in fields from every ancestor", async () => {
    const userExport: ProfileJson = {
      type: "machine",
      name: "MyConfig",
      inherits: "Bambu Lab X1 Carbon 0.4 nozzle",
      // user override of an ancestor's field
      gcode_flavor: "klipper",
    };
    const result = await resolveProfile(userExport, "machine", {
      bundledProfilesPath,
    });

    // Chain ended at fdm_machine_common which has no inherits
    expect(result.inherits).toBeUndefined();
    // User override survives
    expect(result.name).toBe("MyConfig");
    expect(result.gcode_flavor).toBe("klipper");
    // Mid-chain fields baked in
    expect(result.printer_model).toBe("Bambu Lab X1 Carbon");
    expect(result.nozzle_diameter).toEqual(["0.4"]);
    expect(result.printer_variant).toBe("0.4");
    expect(result.printer_technology).toBe("FFF");
    expect(result.nozzle_volume).toBe("92");
    // Deepest-template fields (the ones the CLI needs to see explicitly)
    expect(result.layer_change_gcode).toBe(";LAYER_CHANGE");
  });

  it("rewrites from: 'User' to from: 'system' on the resolved output", async () => {
    // Real OrcaSlicer / BambuStudio user exports always carry
    // `from: "User"`. The CLI's compatibility check then rejects them as
    // incompatible with `from: "system"` process/filament profiles, even
    // when names match. After full flattening the output is functionally
    // equivalent to a system preset, so the resolver re-marks it.
    const userExport: ProfileJson = {
      type: "machine",
      name: "MyConfig",
      inherits: "Bambu Lab X1 Carbon 0.4 nozzle",
      from: "User",
    };
    const result = await resolveProfile(userExport, "machine", {
      bundledProfilesPath,
    });
    expect(result.from).toBe("system");
  });

  it("leaves from untouched when it is not 'User'", async () => {
    const input: ProfileJson = {
      type: "machine",
      name: "flat",
      from: "system",
    };
    const result = await resolveProfile(input, "machine", {
      bundledProfilesPath,
    });
    expect(result.from).toBe("system");
  });

  it("strips the '# ' clone prefix from name on the resolved output", async () => {
    // Real OrcaSlicer GUI exports of cloned system presets prefix the
    // name with "# " (e.g. "# Bambu Lab X1 Carbon 0.4 nozzle"). The CLI
    // matches printer.name literally against compatible_printers in the
    // process / filament profiles, which contain un-prefixed names.
    // Without this strip the slice fails the compatibility check.
    const input: ProfileJson = {
      type: "machine",
      name: "# Bambu Lab X1 Carbon 0.4 nozzle",
      inherits: "Bambu Lab X1 Carbon 0.4 nozzle",
      from: "User",
    };
    const result = await resolveProfile(input, "machine", {
      bundledProfilesPath,
    });
    expect(result.name).toBe("Bambu Lab X1 Carbon 0.4 nozzle");
  });

  it("leaves names without the '# ' prefix unchanged", async () => {
    const input: ProfileJson = {
      type: "machine",
      name: "MyCustomConfig",
      from: "User",
    };
    const result = await resolveProfile(input, "machine", {
      bundledProfilesPath,
    });
    expect(result.name).toBe("MyCustomConfig");
  });

  describe("keepSystemParent (bambuddy#3250)", () => {
    // The CLI checks a process against the printer's system name: its own
    // name when `from` is "system", its `inherits` otherwise. A renamed
    // preset has to keep naming the bundled preset it was saved from.
    const renamed: ProfileJson = {
      type: "machine",
      name: "Bambu Lab X1 Carbon 0.4 nozzle - Skew",
      inherits: "Bambu Lab X1 Carbon 0.4 nozzle",
      from: "User",
      machine_start_gcode: ";MINE",
    };

    it("points a renamed preset at the bundled preset it was saved from", async () => {
      const result = await resolveProfile({ ...renamed }, "machine", {
        bundledProfilesPath,
        keepSystemParent: true,
      });
      expect(result.inherits).toBe("Bambu Lab X1 Carbon 0.4 nozzle");
      expect(result.from).toBe("User");
      // Still flattened, and still the user's own settings and name.
      expect(result.layer_change_gcode).toBe(";LAYER_CHANGE");
      expect(result.printer_model).toBe("Bambu Lab X1 Carbon");
      expect(result.machine_start_gcode).toBe(";MINE");
      expect(result.name).toBe("Bambu Lab X1 Carbon 0.4 nozzle - Skew");
    });

    it("survives normalizeFromField, which the slicing path runs again", async () => {
      const result = await resolveProfile({ ...renamed }, "machine", {
        bundledProfilesPath,
        keepSystemParent: true,
      });
      normalizeFromField(result);
      expect(result.from).toBe("User");
    });

    it("leaves a preset named like its parent as a system preset", async () => {
      const result = await resolveProfile(
        {
          type: "machine",
          name: "Bambu Lab X1 Carbon 0.4 nozzle",
          inherits: "Bambu Lab X1 Carbon 0.4 nozzle",
          from: "system",
        },
        "machine",
        { bundledProfilesPath, keepSystemParent: true },
      );
      expect(result.inherits).toBeUndefined();
      expect(result.from).toBe("system");
    });

    it("leaves a '# ' clone of its parent as a system preset", async () => {
      const result = await resolveProfile(
        {
          type: "machine",
          name: "# Bambu Lab X1 Carbon 0.4 nozzle",
          inherits: "Bambu Lab X1 Carbon 0.4 nozzle",
          from: "User",
        },
        "machine",
        { bundledProfilesPath, keepSystemParent: true },
      );
      expect(result.inherits).toBeUndefined();
      expect(result.from).toBe("system");
    });

    it("leaves a bundled preset written out in full alone", async () => {
      // Its own `inherits` names a template, which no process lists. Taking
      // that as the system name broke every slice with a full profile.
      const result = await resolveProfile(
        {
          type: "machine",
          name: "Bambu Lab X1 Carbon 0.4 nozzle",
          inherits: "fdm_bbl_3dp_001_common",
          from: "system",
        },
        "machine",
        { bundledProfilesPath, keepSystemParent: true },
      );
      expect(result.inherits).toBeUndefined();
      expect(result.from).toBe("system");
    });

    it("never names a template as the parent", async () => {
      const result = await resolveProfile(
        { type: "machine", name: "Mine", inherits: "fdm_bbl_3dp_001_common", from: "User" },
        "machine",
        { bundledProfilesPath, keepSystemParent: true },
      );
      expect(result.inherits).toBeUndefined();
      expect(result.from).toBe("system");
    });

    it("names the selectable preset, not the template it inherits from", async () => {
      const result = await resolveProfile(
        { type: "machine", name: "Mine", inherits: "Bambu Lab X1 Carbon 0.4 nozzle", from: "User" },
        "machine",
        { bundledProfilesPath, keepSystemParent: true },
      );
      expect(result.inherits).toBe("Bambu Lab X1 Carbon 0.4 nozzle");
    });

    it("changes nothing when the parent is not bundled", async () => {
      const result = await resolveProfile(
        { type: "machine", name: "Mine", inherits: "Someone else's preset", from: "User" },
        "machine",
        { bundledProfilesPath, keepSystemParent: true },
      );
      expect(result.inherits).toBeUndefined();
      expect(result.from).toBe("system");
    });

    it("is off unless asked for, so /profiles/resolve output is unchanged", async () => {
      const result = await resolveProfile({ ...renamed }, "machine", {
        bundledProfilesPath,
      });
      expect(result.inherits).toBeUndefined();
      expect(result.from).toBe("system");
    });

    it("reaches the CLI as the system preset it is checked as (OrcaSlicer 2.5.0)", async () => {
      const marked = await resolveProfile({ ...renamed }, "machine", {
        bundledProfilesPath,
        keepSystemParent: true,
      });
      const forCli = cliPrinterPreset(marked);
      // 2.5.0 rejects a standalone user preset with `inherits`.
      expect(forCli.inherits).toBeUndefined();
      expect(forCli.from).toBe("system");
      expect(forCli.name).toBe("Bambu Lab X1 Carbon 0.4 nozzle");
      // The user's own settings, flattened.
      expect(forCli.machine_start_gcode).toBe(";MINE");
      expect(forCli.layer_change_gcode).toBe(";LAYER_CHANGE");
      // The marked preset keeps its identity for acceptPrinterParent.
      expect(printerIdentity(marked)?.name).toBe("Bambu Lab X1 Carbon 0.4 nozzle - Skew");
    });

    it("leaves a preset that is its own system preset alone", () => {
      const system: ProfileJson = { type: "machine", name: "Bambu Lab X1 Carbon 0.4 nozzle", from: "system" };
      expect(cliPrinterPreset(system)).toBe(system);
    });
  });

  it("strips '-1' and empty-string sentinel values from user deltas", async () => {
    // Real OrcaSlicer GUI exports include `-1` for fields the user
    // marked "auto" and `""` for fields they haven't customized. The
    // CLI's range validation rejects these literally
    // (e.g. `prime_tower_brim_width: -1 not in range [0, ∞]`). Dropping
    // them lets the merged profile pick up the bundled ancestor's
    // concrete value (or the CLI's compiled-in default).
    const input: ProfileJson = {
      type: "process",
      name: "user-delta",
      from: "User",
      prime_tower_brim_width: "-1",
      print_settings_id: "",
      ironing_fan_speed: ["-1", "-1", "-1"],
      // Mixed array (some "-1", some real) — keep as-is, that's user intent
      mixed_array: ["-1", "240", "260"],
      // Real user override survives
      top_shell_layers: "3",
    };
    const result = await resolveProfile(input, "process", {
      bundledProfilesPath,
    });
    expect(result.prime_tower_brim_width).toBeUndefined();
    expect(result.print_settings_id).toBeUndefined();
    expect(result.ironing_fan_speed).toBeUndefined();
    expect(result.mixed_array).toEqual(["-1", "240", "260"]);
    expect(result.top_shell_layers).toBe("3");
  });

  it("drops a dangling inherits when the parent file is missing", async () => {
    // Mirrors how upstream's own test fixtures (with stale references like
    // `fdm_process_bbl_0.20`) work today: the CLI ignores unresolvable
    // inherits names from --load-settings, so the resolver does the same.
    const input: ProfileJson = {
      type: "machine",
      name: "self-contained",
      inherits: "Definitely Does Not Exist Preset",
      gcode_flavor: "klipper",
    };
    const result = await resolveProfile(input, "machine", {
      bundledProfilesPath,
    });
    expect(result.inherits).toBeUndefined();
    expect(result.name).toBe("self-contained");
    expect(result.gcode_flavor).toBe("klipper");
  });

  it("throws AppError on a malformed JSON parent", async () => {
    await fs.writeFile(
      path.join(bundledProfilesPath, "machine", "broken.json"),
      "{ not valid json",
    );
    const input: ProfileJson = {
      type: "machine",
      inherits: "broken",
    };
    await expect(
      resolveProfile(input, "machine", { bundledProfilesPath }),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("throws AppError when the chain exceeds maxDepth", async () => {
    await fs.writeFile(
      path.join(bundledProfilesPath, "machine", "cycle_a.json"),
      JSON.stringify({ inherits: "cycle_b" }),
    );
    await fs.writeFile(
      path.join(bundledProfilesPath, "machine", "cycle_b.json"),
      JSON.stringify({ inherits: "cycle_a" }),
    );
    const input: ProfileJson = { type: "machine", inherits: "cycle_a" };
    await expect(
      resolveProfile(input, "machine", { bundledProfilesPath, maxDepth: 4 }),
    ).rejects.toThrow(/exceeded maximum depth/i);
  });
});

describe("ensureProfileType", () => {
  it("stamps type from category when missing", () => {
    // BambuStudio's "Export Preset Bundle" omits `type:` on System-tier
    // printer presets and emits `inherits: ""` (the GUI inferred type from
    // the directory the file lived in). After the inherits walk no-ops on
    // the empty string, the verbatim delta would hit the CLI without a
    // type field and trigger "The input preset file is invalid and can not
    // be parsed." — exactly the demo failure this guard exists to prevent.
    const profile: ProfileJson = {
      name: "Bambu Lab X1 Carbon 0.4 nozzle",
      from: "System",
      inherits: "",
    };
    const result = ensureProfileType(profile, "machine");
    expect(result.type).toBe("machine");
  });

  it("stamps type when the field is an empty string", () => {
    const profile: ProfileJson = { type: "", name: "x" };
    ensureProfileType(profile, "process");
    expect(profile.type).toBe("process");
  });

  it("leaves an already-set type alone", () => {
    // A correctly-shaped user export (or a successfully-resolved
    // ancestor chain) already carries `type:`. We must not clobber it
    // even if the category arg disagrees — the bundle's own value is
    // authoritative and the mismatch would otherwise mask a real
    // mis-categorised file.
    const profile: ProfileJson = { type: "filament", name: "x" };
    ensureProfileType(profile, "machine");
    expect(profile.type).toBe("filament");
  });

  it("works for each ProfileCategory value", () => {
    const machine = ensureProfileType({}, "machine");
    const process = ensureProfileType({}, "process");
    const filament = ensureProfileType({}, "filament");
    expect(machine.type).toBe("machine");
    expect(process.type).toBe("process");
    expect(filament.type).toBe("filament");
  });

  it("mutates the input in place and returns the same reference", () => {
    // materializeProfile relies on the in-place mutation so it can call
    // ensureProfileType after resolveProfile (whose return is the merged
    // chain) without juggling identities.
    const profile: ProfileJson = { name: "x" };
    const result = ensureProfileType(profile, "machine");
    expect(result).toBe(profile);
  });
});

describe("normalizeFromField", () => {
  it("rewrites 'User' to 'system'", () => {
    // User clones flow through resolveProfile's inherits walk and emerge
    // functionally equivalent to a system preset; the CLI's compat check
    // rejects them with `from User unsupported` otherwise.
    const profile: ProfileJson = { name: "x", from: "User" };
    normalizeFromField(profile);
    expect(profile.from).toBe("system");
  });

  it("rewrites 'System' (capital S) to 'system'", () => {
    // BambuStudio's "Export Preset Bundle" for a System-tier root preset
    // writes literal "System" — the GUI accepts that casing because its
    // check is case-insensitive, but the CLI's is not. Without the
    // rewrite the CLI fails with `from System unsupported` (return -5),
    // surfaced as the same "The input preset file is invalid and can not
    // be parsed." rejection as the missing-type case.
    const profile: ProfileJson = { name: "x", from: "System" };
    normalizeFromField(profile);
    expect(profile.from).toBe("system");
  });

  it("leaves 'system' alone", () => {
    const profile: ProfileJson = { name: "x", from: "system" };
    normalizeFromField(profile);
    expect(profile.from).toBe("system");
  });

  it("leaves 'Default' and other distinct tiers untouched", () => {
    // "Default" is a separate tier the CLI handles — rewriting it would
    // mask a real mis-tagged file.
    const profile: ProfileJson = { name: "x", from: "Default" };
    normalizeFromField(profile);
    expect(profile.from).toBe("Default");
  });

  it("leaves a missing from field undefined", () => {
    const profile: ProfileJson = { name: "x" };
    normalizeFromField(profile);
    expect(profile.from).toBeUndefined();
  });

  it("leaves a profile that still names its parent as it is", () => {
    // keepSystemParent's output: a user preset on purpose (bambuddy#3250).
    const profile: ProfileJson = { name: "x", inherits: "y", from: "User" };
    normalizeFromField(profile);
    expect(profile.from).toBe("User");
  });

  it("mutates in place and returns the same reference", () => {
    const profile: ProfileJson = { from: "User" };
    const result = normalizeFromField(profile);
    expect(result).toBe(profile);
  });
});

describe("getDefaultBundledProfilesPath", () => {
  it("prefers BUNDLED_PROFILES_PATH when set", () => {
    const original = {
      bundled: process.env.BUNDLED_PROFILES_PATH,
      orca: process.env.ORCASLICER_PATH,
    };
    try {
      process.env.BUNDLED_PROFILES_PATH = "/explicit/path";
      process.env.ORCASLICER_PATH = "/should/be/ignored/AppRun";
      expect(getDefaultBundledProfilesPath()).toBe("/explicit/path");
    } finally {
      process.env.BUNDLED_PROFILES_PATH = original.bundled;
      process.env.ORCASLICER_PATH = original.orca;
    }
  });

  it("derives from ORCASLICER_PATH when BUNDLED_PROFILES_PATH is unset", () => {
    const original = {
      bundled: process.env.BUNDLED_PROFILES_PATH,
      orca: process.env.ORCASLICER_PATH,
    };
    try {
      delete process.env.BUNDLED_PROFILES_PATH;
      process.env.ORCASLICER_PATH = "/app/squashfs-root/AppRun";
      expect(getDefaultBundledProfilesPath()).toBe(
        path.join("/app/squashfs-root", "resources", "profiles", "BBL"),
      );
    } finally {
      process.env.BUNDLED_PROFILES_PATH = original.bundled;
      process.env.ORCASLICER_PATH = original.orca;
    }
  });

  it("returns undefined when neither env var is set", () => {
    const original = {
      bundled: process.env.BUNDLED_PROFILES_PATH,
      orca: process.env.ORCASLICER_PATH,
    };
    try {
      delete process.env.BUNDLED_PROFILES_PATH;
      delete process.env.ORCASLICER_PATH;
      expect(getDefaultBundledProfilesPath()).toBeUndefined();
    } finally {
      process.env.BUNDLED_PROFILES_PATH = original.bundled;
      process.env.ORCASLICER_PATH = original.orca;
    }
  });
});

// A bundled preset can keep a setting in a companion file named
// `<preset> template <key>.json` that nothing in the preset references
// (bambuddy#2838). Walking `inherits` alone therefore misses it and falls
// through to whatever generic value the root template carries — for
// `machine_start_gcode` on every Bambu machine, a 577-character stub with no
// `M620` AMS load and no `M1002 gcode_claim_action`, which prints in air.
describe("resolveProfile with companion templates", () => {
  let bundledProfilesPath: string;

  const GENERIC_START = "M104 S0 ; generic fallback from the root template";
  const REAL_START = "M620 M ; enable remap\nM1002 gcode_claim_action : 1\n";

  const write = async (name: string, body: Record<string, unknown>) =>
    fs.writeFile(
      path.join(bundledProfilesPath, "machine", `${name}.json`),
      JSON.stringify(body),
    );

  beforeAll(async () => {
    bundledProfilesPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "test-companion-"),
    );
    await fs.mkdir(path.join(bundledProfilesPath, "machine"), {
      recursive: true,
    });

    await write("fdm_machine_common", {
      type: "machine",
      name: "fdm_machine_common",
      machine_start_gcode: GENERIC_START,
      machine_end_gcode: "M104 S0 ; generic end",
    });
    await write("fdm_bbl_3dp_002_common", {
      type: "machine",
      name: "fdm_bbl_3dp_002_common",
      inherits: "fdm_machine_common",
      printer_technology: "FFF",
    });

    // The real layout: the 0.4 carries the companion, the 0.6 inherits it.
    await write("Bambu Lab X2D 0.4 nozzle", {
      type: "machine",
      name: "Bambu Lab X2D 0.4 nozzle",
      inherits: "fdm_bbl_3dp_002_common",
      instantiation: "true",
    });
    await write("Bambu Lab X2D 0.4 nozzle template machine_start_gcode", {
      name: "Bambu Lab X2D 0.4 nozzle template machine_start_gcode",
      instantiation: "false",
      machine_start_gcode: REAL_START,
    });
    await write("Bambu Lab X2D 0.6 nozzle", {
      type: "machine",
      name: "Bambu Lab X2D 0.6 nozzle",
      inherits: "Bambu Lab X2D 0.4 nozzle",
      instantiation: "true",
    });

    // A preset that sets the key inline *and* has a companion. No such case
    // exists in the shipped bundle; this pins which way the tie breaks.
    await write("Inline Wins 0.4 nozzle", {
      type: "machine",
      name: "Inline Wins 0.4 nozzle",
      inherits: "fdm_machine_common",
      machine_start_gcode: "M104 S0 ; set in the preset itself",
    });
    await write("Inline Wins 0.4 nozzle template machine_start_gcode", {
      name: "Inline Wins 0.4 nozzle template machine_start_gcode",
      machine_start_gcode: REAL_START,
    });

    await write("Broken 0.4 nozzle", {
      type: "machine",
      name: "Broken 0.4 nozzle",
      inherits: "fdm_machine_common",
    });
    await fs.writeFile(
      path.join(
        bundledProfilesPath,
        "machine",
        "Broken 0.4 nozzle template machine_start_gcode.json",
      ),
      "{ not json",
    );
  });

  afterAll(async () => {
    await fs.rm(bundledProfilesPath, { recursive: true, force: true });
  });

  const resolve = (profile: ProfileJson) =>
    resolveProfile(profile, "machine", { bundledProfilesPath });

  it("takes the companion's value over the generic one from the root", async () => {
    const result = await resolve({
      type: "machine",
      name: "Bambu Lab X2D 0.4 nozzle",
      inherits: "Bambu Lab X2D 0.4 nozzle",
      from: "system",
    });

    expect(result.machine_start_gcode).toBe(REAL_START);
  });

  it("reaches a companion owned by an ancestor, not just the named preset", async () => {
    // The 0.2 / 0.6 / 0.8 variants have no companion of their own — 27 of the
    // 56 shipped machine presets — and would still print in air if the lookup
    // only considered the preset the caller asked for.
    const result = await resolve({
      type: "machine",
      name: "Bambu Lab X2D 0.6 nozzle",
      inherits: "Bambu Lab X2D 0.6 nozzle",
      from: "system",
    });

    expect(result.machine_start_gcode).toBe(REAL_START);
  });

  it("still falls back to the root template for keys with no companion", async () => {
    const result = await resolve({
      type: "machine",
      name: "Bambu Lab X2D 0.4 nozzle",
      inherits: "Bambu Lab X2D 0.4 nozzle",
      from: "system",
    });

    expect(result.machine_end_gcode).toBe("M104 S0 ; generic end");
  });

  it("lets the caller's own value win over the companion", async () => {
    const result = await resolve({
      type: "machine",
      name: "MyX2D",
      inherits: "Bambu Lab X2D 0.4 nozzle",
      machine_start_gcode: "M104 S0 ; mine",
    });

    expect(result.machine_start_gcode).toBe("M104 S0 ; mine");
  });

  it("lets the preset's own inline value win over its companion", async () => {
    const result = await resolve({
      type: "machine",
      name: "Inline Wins 0.4 nozzle",
      inherits: "Inline Wins 0.4 nozzle",
      from: "system",
    });

    expect(result.machine_start_gcode).toBe("M104 S0 ; set in the preset itself");
  });

  it("does not let the companion's bookkeeping fields leak in", async () => {
    // `name` would rename the preset to "… template machine_start_gcode" and
    // `instantiation: "false"` would mark it unusable.
    const result = await resolve({
      type: "machine",
      name: "Bambu Lab X2D 0.4 nozzle",
      inherits: "Bambu Lab X2D 0.4 nozzle",
      from: "system",
    });

    expect(result.name).toBe("Bambu Lab X2D 0.4 nozzle");
    expect(result.instantiation).toBe("true");
    expect(result.type).toBe("machine");
  });

  it("refuses a malformed companion instead of slicing without it", async () => {
    await expect(
      resolve({
        type: "machine",
        name: "Broken 0.4 nozzle",
        inherits: "Broken 0.4 nozzle",
        from: "system",
      }),
    ).rejects.toThrow(/template is not valid JSON/);
  });

  it("resolves normally when the category has no bundled directory", async () => {
    const result = await resolveProfile(
      { type: "process", name: "p", inherits: "nothing_here" },
      "process",
      { bundledProfilesPath },
    );

    expect(result.name).toBe("p");
    expect(result.inherits).toBeUndefined();
  });
});

describe("printerIdentity / acceptPrinterParent (bambuddy#3250)", () => {
  const renamed: ProfileJson = {
    name: "Bambu Lab H2D 0.4 nozzle - Skew",
    inherits: "Bambu Lab H2D 0.4 nozzle",
    from: "User",
  };
  const identity = { name: "Bambu Lab H2D 0.4 nozzle - Skew", systemName: "Bambu Lab H2D 0.4 nozzle" };

  it("reads the two names of a printer keepSystemParent pointed at its parent", () => {
    expect(printerIdentity(renamed)).toEqual(identity);
  });

  it("has nothing to say about a printer that is its own system preset", () => {
    expect(printerIdentity({ name: "Bambu Lab H2D 0.4 nozzle", from: "system" })).toBeNull();
    expect(printerIdentity({ name: "x", from: "User" })).toBeNull();
  });

  it("adds the parent to a list that names the printer itself", () => {
    // The GUI accepts either name; the CLI checks only the parent.
    const process: ProfileJson = { compatible_printers: [identity.name] };
    acceptPrinterParent(process, identity);
    expect(process.compatible_printers).toEqual([identity.name, identity.systemName]);
  });

  it("leaves a list that already names the parent alone", () => {
    const list = [identity.systemName, "Bambu Lab X1 Carbon 0.4 nozzle"];
    const process: ProfileJson = { compatible_printers: [...list] };
    acceptPrinterParent(process, identity);
    expect(process.compatible_printers).toEqual(list);
  });

  it("never makes a list for another printer fit", () => {
    const process: ProfileJson = { compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"] };
    acceptPrinterParent(process, identity);
    expect(process.compatible_printers).toEqual(["Bambu Lab X1 Carbon 0.4 nozzle"]);
  });

  it("leaves missing lists and stock printers alone", () => {
    const none: ProfileJson = {};
    acceptPrinterParent(none, identity);
    expect(none.compatible_printers).toBeUndefined();
    const process: ProfileJson = { compatible_printers: [identity.name] };
    acceptPrinterParent(process, null);
    expect(process.compatible_printers).toEqual([identity.name]);
  });
});
