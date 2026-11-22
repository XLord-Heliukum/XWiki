import { extname, join, relative, resolve, sep } from "path";
import { getFolderConfig, isFolderMetadataFile } from "./folderConfig.js";

/**
 * `pathPolicy` in folder metadata: which characters file and folder names may
 * use. It governs everything in the folder and below until a deeper folder's
 * metadata sets its own. See docs/FOLDER_METADATA.md.
 *
 * Reads go through getFolderConfig (tracedFs), so a node that consults a
 * policy re-runs when the policy changes. A file or folder that breaks a policy
 * takes no part in the build, the same as `hidden: true`: documentSet is what
 * finds and reports them, and every other walker of the source tree asks this
 * module so that it skips the same names.
 */

/** Thrown by a build pass when a name breaks a policy with `failBuild: true`. */
export class PathPolicyError extends Error {
  constructor(errors) {
    const fatal = errors.filter((e) => e.failBuild);
    super(`Build failed: ${fatal.length} path policy error(s), first: ${formatPathPolicyError(fatal[0])}`);
    this.name = "PathPolicyError";
    this.errors = errors;
  }
}

const compiledPatterns = new Map();

function compile(pattern) {
  if (!compiledPatterns.has(pattern)) {
    new RegExp(pattern, "u"); // on its own first: "a)(b" only compiles inside the wrapper
    compiledPatterns.set(pattern, new RegExp(`^(?:${pattern})$`, "u"));
  }
  return compiledPatterns.get(pattern);
}

function relOf(path, source) {
  return relative(resolve(source), path).split(sep).join("/");
}

/**
 * The policy governing a folder's entries, given the one it inherits. A policy
 * in the folder replaces the inherited one whole; `false` or `null` turns
 * policies off below it. An invalid one is reported and the inherited one stays.
 *
 * @param {string} folderPath - Absolute path to the folder
 * @param {string} source - The docroot
 * @param {object|null} [inherited] - The policy governing the folder's parent
 * @returns {{policy: object|null, problem: object|null}} `problem` is an error
 *   record for formatPathPolicyError when the folder's policy is invalid
 */
export function readPathPolicy(folderPath, source, inherited = null) {
  const raw = getFolderConfig(folderPath)?.pathPolicy;
  if (raw === undefined) return { policy: inherited, problem: null };
  if (raw === false || raw === null) return { policy: null, problem: null };
  const definedIn = relOf(folderPath, source);
  const invalid = (reason) => ({
    policy: inherited,
    problem: { kind: "policy", path: definedIn, reason, failBuild: raw?.failBuild === true },
  });
  if (typeof raw?.allowedCharacters !== "string") return invalid("allowedCharacters must be a string");
  let regex;
  try {
    regex = compile(raw.allowedCharacters);
  } catch (e) {
    return invalid(e.message);
  }
  return {
    policy: { allowedCharacters: raw.allowedCharacters, regex, failBuild: raw.failBuild === true, definedIn },
    problem: null,
  };
}

/** The policy governing a folder's entries, read from the docroot down. */
export function effectivePathPolicy(folderPath, source) {
  const root = resolve(source);
  const rel = relative(root, resolve(folderPath));
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  let current = root;
  let { policy } = readPathPolicy(current, root);
  for (const segment of rel ? rel.split(sep) : []) {
    current = join(current, segment);
    ({ policy } = readPathPolicy(current, root, policy));
  }
  return policy;
}

/**
 * The characters of a name its policy does not allow. A file's extension is
 * judged but the dot before it is not, so `[a-z]` passes `page.md` and rejects
 * `page.MD` and `a.b.md`. Metadata files are exempt: a folder's policy is read
 * from them.
 *
 * @param {string} name - Basename of a file or folder
 * @param {boolean} isDirectory
 * @param {object|null} policy - From readPathPolicy or effectivePathPolicy
 * @returns {string[]} The distinct characters that break the policy
 */
export function disallowedCharacters(name, isDirectory, policy) {
  if (!policy) return [];
  if (!isDirectory && isFolderMetadataFile(name)) return [];
  const ext = isDirectory ? "" : extname(name);
  const judged = ext ? name.slice(0, -ext.length) + ext.slice(1) : name;
  return [...new Set(judged)].filter((char) => !policy.regex.test(char));
}

/** An error record when a name breaks its policy, or null. */
export function pathPolicyViolation(name, isDirectory, rel, policy) {
  const characters = disallowedCharacters(name, isDirectory, policy);
  if (characters.length === 0) return null;
  return {
    kind: isDirectory ? "folder" : "file",
    path: rel,
    characters,
    allowedCharacters: policy.allowedCharacters,
    definedIn: policy.definedIn,
    failBuild: policy.failBuild,
  };
}

/**
 * True when a path, or any folder on the way to it from the docroot, breaks the
 * policy governing it.
 *
 * @param {string} path - Absolute path to a file or folder
 * @param {string} source - The docroot
 * @param {{isDirectory?: boolean}} [opts] - What the last segment is (default: a file)
 */
export function violatesPathPolicy(path, source, { isDirectory = false } = {}) {
  const root = resolve(source);
  const rel = relative(root, resolve(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  const segments = rel.split(sep);
  let current = root;
  let { policy } = readPathPolicy(current, root);
  for (const [i, segment] of segments.entries()) {
    const isLast = i === segments.length - 1;
    if (disallowedCharacters(segment, !isLast || isDirectory, policy).length > 0) return true;
    if (isLast) break;
    current = join(current, segment);
    ({ policy } = readPathPolicy(current, root, policy));
  }
  return false;
}

/** One line describing an error record from documentSet. */
export function formatPathPolicyError(error) {
  if (error.kind === "policy") {
    return `${error.path || "(docroot)"}: invalid pathPolicy: ${error.reason}`;
  }
  const characters = error.characters.map((c) => JSON.stringify(c)).join(", ");
  const where = error.definedIn ? `${error.definedIn}/` : "docroot ";
  return `${error.path} (${error.kind}): ${characters} not allowed by ${error.allowedCharacters} (pathPolicy in ${where}metadata)`;
}
