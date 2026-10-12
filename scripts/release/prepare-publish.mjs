#!/usr/bin/env node
/**
 * Checks an npm package of this repository before it is published, and turns
 * its local links to other packages of this repository into exact versions.
 *
 *   node scripts/release/prepare-publish.mjs <package dir> [--check]
 *
 * In development the MCP server depends on the SDK as `"@noisedlabs/sdk":
 * "file:../../sdk"` (a copy of the local build). A published package cannot
 * point at a path, so this script replaces every `file:`, `link:` or
 * `workspace:` dependency with the EXACT version in the package.json it
 * points at (for example `"0.9.0"`), and refuses to continue if that package
 * is not the same name or is itself private.
 *
 * It also refuses a package that:
 * - is `private`, or lacks `publishConfig.access: "public"` and
 *   `publishConfig.provenance: true`;
 * - has a dependency that is not an exact version (`dependencies`,
 *   `optionalDependencies`; `peerDependencies` may be ranges);
 * - has no `files` allow-list, or lists a test, fixture or vector path in it;
 * - has no LICENSE or README.md.
 *
 * --check  validate only (exit 1 on a problem); never writes.
 * Without --check the package.json is rewritten in place: run it in the CI
 * checkout that publishes, never in a working copy you commit from.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const dirArg = args.find((a) => !a.startsWith("--"));
if (!dirArg) {
  console.error("usage: node scripts/release/prepare-publish.mjs <package dir> [--check]");
  process.exit(2);
}
const dir = resolve(dirArg);
const pkgPath = join(dir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const problems = [];
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (pkg.private === true) problems.push(`"private": true`);
if (!EXACT.test(pkg.version ?? "")) problems.push(`version ${pkg.version} is not an exact semver version`);
if (pkg.publishConfig?.access !== "public") problems.push(`publishConfig.access must be "public"`);
if (pkg.publishConfig?.provenance !== true) problems.push(`publishConfig.provenance must be true`);
if (!Array.isArray(pkg.files) || pkg.files.length === 0) problems.push(`no "files" allow-list`);
for (const f of pkg.files ?? []) {
  if (/(^|\/)(test|tests|__tests__|fixtures?|vectors|examples|scripts|coverage)(\/|$)/i.test(f) || /\.(env|log|tgz)$/.test(f)) {
    problems.push(`"files" includes ${f}`);
  }
}
for (const f of ["LICENSE", "README.md"]) if (!existsSync(join(dir, f))) problems.push(`missing ${f}`);
if (!pkg.repository?.url || /TODO|TBD/.test(pkg.repository.url)) {
  problems.push(`repository.url is a placeholder (${pkg.repository?.url}); set scripts/release/repo-config.json and run apply-repo-config.mjs`);
}

const rewrites = [];
for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    const local = /^(file|link|workspace):(.*)$/.exec(spec);
    if (local) {
      if (field === "peerDependencies") {
        problems.push(`${field}.${name} is a local link (${spec})`);
        continue;
      }
      const target = resolve(dir, local[1] === "workspace" ? "" : local[2]);
      const targetPkgPath = join(target, "package.json");
      if (!existsSync(targetPkgPath)) {
        problems.push(`${field}.${name}: ${spec} has no package.json`);
        continue;
      }
      const t = JSON.parse(readFileSync(targetPkgPath, "utf8"));
      if (t.name !== name) problems.push(`${field}.${name}: ${spec} is the package ${t.name}`);
      else if (t.private === true) problems.push(`${field}.${name}: ${spec} is private, so it is not on the registry`);
      else if (!EXACT.test(t.version ?? "")) problems.push(`${field}.${name}: ${spec} has version ${t.version}`);
      else {
        rewrites.push(`${field}.${name}: ${spec} -> ${t.version}`);
        pkg[field][name] = t.version;
      }
      continue;
    }
    if (field !== "peerDependencies" && !EXACT.test(spec)) {
      problems.push(`${field}.${name} is not an exact version (${spec})`);
    }
  }
}

if (problems.length > 0) {
  console.error(`${pkg.name}@${pkg.version}: not publishable:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
for (const r of rewrites) console.log(`${pkg.name}: ${r}`);
if (!CHECK && rewrites.length > 0) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`${pkg.name}@${pkg.version}: ready to publish${CHECK && rewrites.length > 0 ? " (after the rewrites above)" : ""}`);
