#!/usr/bin/env bun

/**
 * Publish all @storic packages in topological dependency order.
 *
 * - Reads the workspace to discover packages and their @storic/* dependencies
 * - Topologically sorts so upstream packages publish first
 * - Pre-flight checks that all @storic/* dependencies exist on npm before publishing
 * - If a package fails to publish, all downstream dependents are skipped
 *
 * Usage:
 *   bun scripts/publish-all.ts
 */

import { join } from "node:path";
import { getPackageInfo, getNpmVersion, shouldPublish, publishPackage } from "./publish-package";

interface WorkspacePackage {
  /** Short name, e.g. "core" */
  name: string;
  /** Full scoped name, e.g. "@storic/core" */
  packageName: string;
  /** Path relative to repo root, e.g. "packages/core" */
  path: string;
  /** Local version from package.json */
  version: string;
  /** @storic/* dependency names (scoped), e.g. ["@storic/core"] */
  storicDeps: string[];
}

/**
 * Discover all @storic/* packages and their internal dependencies
 */
async function discoverPackages(): Promise<WorkspacePackage[]> {
  const packagesDir = "packages";
  const glob = new Bun.Glob("*/package.json");
  const packages: WorkspacePackage[] = [];

  for await (const path of glob.scan({ cwd: packagesDir })) {
    const fullPath = join(packagesDir, path);
    const pkg = await Bun.file(fullPath).json();

    if (!pkg.name?.startsWith("@storic/")) continue;

    const shortName = pkg.name.replace("@storic/", "");
    const allDeps = { ...pkg.dependencies, ...pkg.peerDependencies };
    const storicDeps = Object.keys(allDeps).filter((d) => d.startsWith("@storic/"));

    packages.push({
      name: shortName,
      packageName: pkg.name,
      path: join(packagesDir, shortName),
      version: pkg.version,
      storicDeps,
    });
  }

  return packages;
}

/**
 * Topological sort using Kahn's algorithm.
 * Returns packages in publish order (dependencies first).
 */
function topologicalSort(packages: WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map((p) => [p.packageName, p]));

  // Build in-degree map (only counting edges within our package set)
  const inDegree = new Map(packages.map((p) => [p.packageName, 0]));
  for (const pkg of packages) {
    for (const dep of pkg.storicDeps) {
      if (byName.has(dep)) {
        inDegree.set(pkg.packageName, (inDegree.get(pkg.packageName) ?? 0) + 1);
      }
    }
  }

  // Start with packages that have no internal dependencies
  const queue = packages.filter((p) => inDegree.get(p.packageName) === 0).map((p) => p.packageName);
  const sorted: WorkspacePackage[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(byName.get(current)!);

    // For each package that depends on `current`, decrement in-degree
    for (const pkg of packages) {
      if (pkg.storicDeps.includes(current) && byName.has(pkg.packageName)) {
        const newDegree = (inDegree.get(pkg.packageName) ?? 1) - 1;
        inDegree.set(pkg.packageName, newDegree);
        if (newDegree === 0) {
          queue.push(pkg.packageName);
        }
      }
    }
  }

  if (sorted.length !== packages.length) {
    const missing = packages.filter((p) => !sorted.includes(p)).map((p) => p.packageName);
    throw new Error(`Circular dependency detected involving: ${missing.join(", ")}`);
  }

  return sorted;
}

/**
 * Check that all @storic/* dependencies for a package are available on npm
 * at the versions that workspace:* will resolve to.
 */
async function preflightCheck(
  pkg: WorkspacePackage,
  allPackages: Map<string, WorkspacePackage>,
  justPublished: Set<string>,
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];

  for (const dep of pkg.storicDeps) {
    const depPkg = allPackages.get(dep);
    if (!depPkg) continue; // external dep, skip

    const requiredVersion = depPkg.version;

    // If we just published this dep in this run, trust it
    if (justPublished.has(dep)) continue;

    const npmVersion = await getNpmVersion(dep);
    if (npmVersion !== requiredVersion) {
      missing.push(`${dep}@${requiredVersion} (npm has ${npmVersion || "nothing"})`);
    }
  }

  return { ok: missing.length === 0, missing };
}

async function main(): Promise<void> {
  console.log("Discovering packages...\n");
  const packages = await discoverPackages();
  const sorted = topologicalSort(packages);

  console.log("Publish order:");
  for (const pkg of sorted) {
    const deps = pkg.storicDeps.length > 0 ? ` (depends on ${pkg.storicDeps.join(", ")})` : "";
    console.log(`  ${pkg.packageName}@${pkg.version}${deps}`);
  }
  console.log();

  const allPackages = new Map(sorted.map((p) => [p.packageName, p]));
  const justPublished = new Set<string>();
  const blocked = new Set<string>();
  let hasFailures = false;

  for (const pkg of sorted) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`${pkg.packageName}@${pkg.version}`);

    // Check if this package is blocked because an upstream dep failed
    const blockedBy = pkg.storicDeps.find((dep) => blocked.has(dep));
    if (blockedBy) {
      console.log(`  ⊘ Skipped — blocked by failed dependency ${blockedBy}`);
      blocked.add(pkg.packageName);
      hasFailures = true;
      continue;
    }

    // Check if publish is needed
    const npmVersion = await getNpmVersion(pkg.packageName);
    console.log(`  Local: ${pkg.version}  npm: ${npmVersion}`);

    if (!shouldPublish(pkg.version, npmVersion)) {
      console.log(`  ⊘ Skipped — already published`);
      // Treat as available for downstream pre-flight checks
      justPublished.add(pkg.packageName);
      continue;
    }

    // Pre-flight: verify all @storic/* deps are available on npm
    const preflight = await preflightCheck(pkg, allPackages, justPublished);
    if (!preflight.ok) {
      console.log(`  ✗ Pre-flight failed — missing dependencies:`);
      for (const m of preflight.missing) {
        console.log(`      ${m}`);
      }
      blocked.add(pkg.packageName);
      hasFailures = true;
      continue;
    }

    // Publish
    try {
      await publishPackage(pkg.packageName, pkg.path);
      justPublished.add(pkg.packageName);
      console.log(`  ✓ Published`);
    } catch (error) {
      console.error(`  ✗ Failed to publish:`, error);
      blocked.add(pkg.packageName);
      hasFailures = true;
    }
  }

  // Summary
  console.log(`\n${"─".repeat(60)}`);
  console.log("Summary:");
  console.log(`  Published: ${justPublished.size}`);
  console.log(`  Blocked/Failed: ${blocked.size}`);

  if (blocked.size > 0) {
    console.log(`  Failed packages: ${Array.from(blocked).join(", ")}`);
  }

  if (hasFailures) {
    process.exit(1);
  }
}

await main();
