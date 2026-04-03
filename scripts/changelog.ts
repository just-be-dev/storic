#!/usr/bin/env bun

/**
 * Shared categorization functions for changelog generation
 *
 * This module contains reusable functions for categorizing PRs by file paths.
 * Used by changelog-entry.ts and other scripts.
 */

/**
 * Extract category from file path
 * - packages/{name}/ -> @storic/{name}
 * - Everything else -> General
 */
export function getCategoryFromPath(filePath: string): string {
  const packageMatch = filePath.match(/^packages\/([^/]+)\//);
  if (packageMatch) {
    return `@storic/${packageMatch[1]}`;
  }

  return "General";
}

/**
 * Get priority for a category (lower is higher priority)
 * Used for tie-breaking when multiple categories have the same file count
 */
export function getCategoryPriority(category: string): number {
  if (category.startsWith("@storic/")) return 1; // Packages highest priority
  return 2; // General lowest priority
}

/**
 * Categorize a PR based on files changed
 * Counts files in each category and picks the one with the most files
 * In case of a tie, prefers packages over general
 */
export function categorizeFiles(files: string[]): string {
  const categories = new Map<string, number>();

  for (const file of files) {
    const category = getCategoryFromPath(file);
    categories.set(category, (categories.get(category) || 0) + 1);
  }

  // Find category with most files (with priority-based tie-breaking)
  let maxCount = 0;
  let selectedCategory = "General";
  let selectedPriority = getCategoryPriority("General");

  for (const [category, count] of categories) {
    const priority = getCategoryPriority(category);

    if (count > maxCount || (count === maxCount && priority < selectedPriority)) {
      maxCount = count;
      selectedCategory = category;
      selectedPriority = priority;
    }
  }

  return selectedCategory;
}
