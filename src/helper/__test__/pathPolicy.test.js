import { join } from "path";
import { existsSync } from "fs";
import { mkdtemp, mkdir, writeFile, rm, readFile, rename } from "fs/promises";
import { tmpdir } from "os";
import { jest } from "@jest/globals";
import {
  PathPolicyError,
  disallowedCharacters,
  effectivePathPolicy,
  formatPathPolicyError,
  readPathPolicy,
  violatesPathPolicy,
} from "../pathPolicy.js";
import { createBuild } from "../build/pass.js";

const LOWER = '{ "pathPolicy": { "allowedCharacters": "[a-z0-9-_]" } }';
const LOWER_FATAL = '{ "pathPolicy": { "allowedCharacters": "[a-z0-9-_]", "failBuild": true } }';

let tempDir;
let source;
let meta;
let output;
let consoleError;

async function write(rel, contents = "# Page\n") {
  const full = join(source, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, contents);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ursa-path-policy-"));
  source = join(tempDir, "src");
  meta = join(tempDir, "meta");
  output = join(tempDir, "out");
  await mkdir(source, { recursive: true });
  await mkdir(join(meta, "templates/default-template"), { recursive: true });
  await writeFile(
    join(meta, "templates/default-template/index.html"),
    "<html><head><title>${title}</title></head><body><nav>${menu}</nav><article>${body}</article></body></html>"
  );
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

async function runBuild(opts = {}) {
  const build = await createBuild({ source, meta, output, log: () => {}, ...opts });
  try {
    return await build.runPass({ rescan: true });
  } finally {
    await build.close();
  }
}

const built = (rel) => existsSync(join(output, rel));
const errorPaths = (summary) => summary.pathPolicyErrors.map((e) => e.path);

describe("disallowedCharacters", () => {
  const policy = { regex: /^(?:[a-z0-9-_])$/u };

  it("accepts the character class in the docs, hyphen and all", async () => {
    await write("metadata.json", LOWER);
    const { policy: read, problem } = readPathPolicy(source, source);
    expect(problem).toBeNull();
    expect(disallowedCharacters("a-b_c9.md", false, read)).toEqual([]);
  });

  it("judges a file's extension but not the dot before it", () => {
    expect(disallowedCharacters("page.md", false, policy)).toEqual([]);
    expect(disallowedCharacters("page.MD", false, policy)).toEqual(["M", "D"]);
    expect(disallowedCharacters("a.b.md", false, policy)).toEqual(["."]);
  });

  it("judges every character of a folder name", () => {
    expect(disallowedCharacters("v1.0", true, policy)).toEqual(["."]);
    expect(disallowedCharacters("My Folder", true, policy)).toEqual(["M", " ", "F"]);
  });

  it("exempts metadata files, which the policy is read from", () => {
    const strict = { regex: /^(?:[A-Z])$/u };
    expect(disallowedCharacters("config.json", false, strict)).toEqual([]);
    expect(disallowedCharacters("metadata.yml", false, strict)).toEqual([]);
    expect(disallowedCharacters("config.json", true, strict).length).toBeGreaterThan(0);
  });

  it("allows everything with no policy", () => {
    expect(disallowedCharacters("ANY Name!.md", false, null)).toEqual([]);
  });

  it("takes an anchored pattern, one character at a time", async () => {
    await write("metadata.json", '{ "pathPolicy": { "allowedCharacters": "^[a-z]+$" } }');
    const { policy: read } = readPathPolicy(source, source);
    expect(disallowedCharacters("abc", true, read)).toEqual([]);
    expect(disallowedCharacters("aBc", true, read)).toEqual(["B"]);
  });

  it("stays quick on a long name with a pattern that could backtrack", async () => {
    await write("metadata.json", '{ "pathPolicy": { "allowedCharacters": "([a-z]+)+" } }');
    const { policy: read } = readPathPolicy(source, source);
    expect(disallowedCharacters(`${"a".repeat(200)}!`, true, read)).toEqual(["!"]);
  });
});

describe("policy scope", () => {
  it("inherits, is replaced whole by a deeper folder, and can be turned off", async () => {
    await write("metadata.json", LOWER_FATAL);
    await write("loose/metadata.json", '{ "pathPolicy": { "allowedCharacters": "[A-Z]" } }');
    await write("off/metadata.json", '{ "pathPolicy": false }');
    await write("plain/keep.md");

    expect(effectivePathPolicy(join(source, "plain"), source)).toMatchObject({ allowedCharacters: "[a-z0-9-_]", failBuild: true, definedIn: "" });
    expect(effectivePathPolicy(join(source, "loose"), source)).toMatchObject({ allowedCharacters: "[A-Z]", failBuild: false, definedIn: "loose" });
    expect(effectivePathPolicy(join(source, "off"), source)).toBeNull();
  });

  it("reads metadata.yml as well as config.json", async () => {
    await write("metadata.yml", "pathPolicy:\n  allowedCharacters: '[a-z]'\n");
    expect(effectivePathPolicy(source, source).allowedCharacters).toBe("[a-z]");
  });

  it("finds a violation anywhere on the path, and only inside the docroot", async () => {
    await write("metadata.json", LOWER);
    await write("Bad/ok.md");
    await write("good/ok.md");
    await write("good/Bad.md");
    expect(violatesPathPolicy(join(source, "Bad/ok.md"), source)).toBe(true);
    expect(violatesPathPolicy(join(source, "good/Bad.md"), source)).toBe(true);
    expect(violatesPathPolicy(join(source, "good/ok.md"), source)).toBe(false);
    expect(violatesPathPolicy(join(source, "Bad"), source, { isDirectory: true })).toBe(true);
    expect(violatesPathPolicy(join(tempDir, "Elsewhere/X.md"), source)).toBe(false);
    expect(violatesPathPolicy(source, source)).toBe(false);
  });

  it("does not judge a folder by its own policy", async () => {
    await write("Upper/metadata.json", '{ "pathPolicy": { "allowedCharacters": "[a-z.]" } }');
    await write("Upper/ok.md");
    expect(violatesPathPolicy(join(source, "Upper/ok.md"), source)).toBe(false);
  });
});

describe("failBuild: false", () => {
  beforeEach(async () => {
    await write("metadata.json", LOWER);
    await write("index.md", "# Home\n");
    await write("good.md");
    await write("Bad-Page.md");
    await write("Bad-Folder/inside.md");
    await write("Bad-Folder/Deeper/inside.md");
    await write("assets/Photo.png", "not really a png");
    await write("assets/photo.mp4", "video");
    await write("assets/Clip.mp4", "video");
  });

  it("reports offenders, skips them, and finishes the build", async () => {
    const summary = await runBuild();

    expect(built("good.html")).toBe(true);
    expect(built("assets/photo.mp4")).toBe(true);
    expect(built("Bad-Page.html")).toBe(false);
    expect(built("Bad-Page.json")).toBe(false);
    expect(built("Bad-Folder")).toBe(false);
    expect(built("assets/Photo.png")).toBe(false);
    expect(built("assets/Clip.mp4")).toBe(false);

    expect(errorPaths(summary)).toEqual(["Bad-Folder", "Bad-Page.md", "assets/Clip.mp4", "assets/Photo.png"]);
    expect(summary.pathPolicyErrors.every((e) => e.failBuild === false)).toBe(true);
    expect(consoleError.mock.calls.flat().join("\n")).toContain("Bad-Page.md (file)");
  });

  it("leaves them out of the menu, auto-indexes and _directory.json", async () => {
    await write("listed/index.md", "---\ngenerate-auto-index: true\n---\n\n# Listed\n");
    await write("listed/fine.md");
    await write("listed/Hidden-Page.md");
    await write("listed/Hidden-Folder/inside.md");
    await runBuild();

    const everything = [
      await readFile(join(output, "public/menu-data.json"), "utf8"),
      await readFile(join(output, "_directory.json"), "utf8"),
      await readFile(join(output, "listed/_directory.json"), "utf8"),
      await readFile(join(output, "listed/index.html"), "utf8"),
    ].join("\n");
    expect(everything).toContain("fine");
    expect(everything).not.toMatch(/Hidden-Page|Hidden-Folder|Bad-Page|Bad-Folder/);
  });

  it("leaves them out of an auto-generated custom menu", async () => {
    await write("area/menu.md", "---\nauto-generate-menu: true\n---\n\n{menu}\n");
    await write("area/fine.md");
    await write("area/Bad-Doc.md");
    await write("area/Bad-Dir/inside.md");
    await runBuild();

    const menu = await readFile(join(output, "public/custom-menu-area.json"), "utf8");
    expect(menu).toContain("fine");
    expect(menu).not.toMatch(/Bad-Doc|Bad-Dir/i);
  });

  it("does not copy an offending image a page references", async () => {
    await write("gallery.md", "# Gallery\n\n![p](assets/Photo.png)\n");
    await runBuild();
    expect(built("gallery.html")).toBe(true);
    expect(built("assets/Photo.png")).toBe(false);
  });

  it("reports again on a warm build", async () => {
    await runBuild();
    const warm = await runBuild();
    expect(errorPaths(warm)).toContain("Bad-Page.md");
  });

  it("follows the policy being added and removed between builds", async () => {
    await write("metadata.json", "{}");
    await runBuild();
    expect(built("Bad-Page.html")).toBe(true);
    expect(built("Bad-Folder/inside.html")).toBe(true);

    await write("metadata.json", LOWER);
    await runBuild();
    expect(built("Bad-Page.html")).toBe(false);
    expect(built("Bad-Folder/inside.html")).toBe(false);
    expect(await readFile(join(output, "public/menu-data.json"), "utf8")).not.toMatch(/Bad-Page|Bad-Folder/);
    expect(built("good.html")).toBe(true);

    await write("metadata.json", "{}");
    const summary = await runBuild();
    expect(summary.pathPolicyErrors).toEqual([]);
    expect(built("Bad-Page.html")).toBe(true);
    expect(await readFile(join(output, "public/menu-data.json"), "utf8")).toMatch(/Bad-Page|Bad Page/);
  });

  it("does not judge what the build already ignores", async () => {
    await write(".Drafts/X.md");
    await write("Secret/metadata.json", '{ "hidden": true }');
    await write("Excluded/page.md");
    const summary = await runBuild({ exclude: "Excluded" });
    expect(errorPaths(summary)).not.toEqual(expect.arrayContaining([".Drafts"]));
    expect(errorPaths(summary)).not.toContain("Secret");
    expect(errorPaths(summary)).not.toContain("Excluded");
  });

  it("lets a deeper folder relax the policy", async () => {
    await write("free/metadata.json", '{ "pathPolicy": false }');
    await write("free/ANY-Name.md");
    const summary = await runBuild();
    expect(built("free/ANY-Name.html")).toBe(true);
    expect(errorPaths(summary)).not.toContain("free/ANY-Name.md");
  });
});

describe("failBuild: true", () => {
  beforeEach(async () => {
    await write("metadata.json", LOWER_FATAL);
    await write("index.md", "# Home\n");
    await write("good.md");
  });

  it("builds normally with nothing to report", async () => {
    const summary = await runBuild();
    expect(summary.pathPolicyErrors).toEqual([]);
    expect(built("good.html")).toBe(true);
  });

  it("throws before writing any output", async () => {
    await write("Bad-Page.md");
    await expect(runBuild()).rejects.toThrow(PathPolicyError);
    expect(built("good.html")).toBe(false);
    expect(consoleError.mock.calls.flat().join("\n")).toContain("Bad-Page.md (file)");
  });

  it("carries every error, and names the first fatal one in its message", async () => {
    await write("Bad-Page.md");
    await write("loose/metadata.json", '{ "pathPolicy": { "allowedCharacters": "[a-z.]" } }');
    await write("loose/Mild.md");
    const error = await runBuild().catch((e) => e);
    expect(error.errors.map((e) => e.path)).toEqual(["Bad-Page.md", "loose/Mild.md"]);
    expect(error.message).toContain("1 path policy error(s)");
    expect(error.message).toContain("Bad-Page.md");
  });

  it("can pass again once the name is fixed, in the same process", async () => {
    await write("Bad-Page.md");
    const build = await createBuild({ source, meta, output, log: () => {} });
    await expect(build.runPass({ rescan: true })).rejects.toThrow(PathPolicyError);
    await rename(join(source, "Bad-Page.md"), join(source, "fixed-page.md"));
    build.invalidate([join(source, "Bad-Page.md"), join(source, "fixed-page.md"), source]);
    const summary = await build.runPass({ rescan: true });
    await build.close();
    expect(summary.pathPolicyErrors).toEqual([]);
    expect(built("fixed-page.html")).toBe(true);
  });

  it("does not fail for a violation under a deeper non-fatal policy", async () => {
    await write("loose/metadata.json", '{ "pathPolicy": { "allowedCharacters": "[a-z.]" } }');
    await write("loose/Mild.md");
    const summary = await runBuild();
    expect(errorPaths(summary)).toEqual(["loose/Mild.md"]);
    expect(built("good.html")).toBe(true);
    expect(built("loose/Mild.html")).toBe(false);
  });
});

describe("invalid policies", () => {
  it("reports a bad regex and keeps the inherited policy", async () => {
    await write("metadata.json", LOWER);
    await write("broken/metadata.json", '{ "pathPolicy": { "allowedCharacters": "[" } }');
    await write("broken/Still-Bad.md");
    await write("broken/fine.md");
    const summary = await runBuild();

    const problem = summary.pathPolicyErrors.find((e) => e.kind === "policy");
    expect(problem.path).toBe("broken");
    expect(formatPathPolicyError(problem)).toContain("broken: invalid pathPolicy");
    expect(errorPaths(summary)).toContain("broken/Still-Bad.md");
    expect(built("broken/fine.html")).toBe(true);
  });

  it("rejects a pattern that only compiles inside the wrapper", async () => {
    await write("metadata.json", '{ "pathPolicy": { "allowedCharacters": "a)(b" } }');
    expect(readPathPolicy(source, source).problem.kind).toBe("policy");
  });

  it("reports a missing allowedCharacters, and fails if it says failBuild", async () => {
    await write("index.md", "# Home\n");
    await write("metadata.json", '{ "pathPolicy": { "failBuild": true } }');
    await expect(runBuild()).rejects.toThrow(PathPolicyError);

    await write("metadata.json", '{ "pathPolicy": { "failBuild": false } }');
    const summary = await runBuild();
    expect(summary.pathPolicyErrors[0].reason).toContain("allowedCharacters");
    expect(built("index.html")).toBe(true);
  });
});
