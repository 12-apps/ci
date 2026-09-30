/**
 * The stack test: does one branch already hold another PR's own commits?
 *
 * Shared by `report` (a sync that met the branch's own squash-merged parent is
 * `stacked`, not a collision) and `overlap` (a child's overlap with its parent
 * is expected, and is not a warning worth posting on either).
 */
import { countRange } from "./git.mjs";

/**
 * `branchSide` holds commits of `head` that are not on `mainSide`: some of
 * `head`'s commits are reachable from the branch but not from the base.
 *
 * |H \ M ∩ B| is computed as |H \ M| − |H \ (M ∪ B)|, never as |H \ M| − |H \ B|:
 * a parent that merged the base after the child branched holds base commits
 * the child lacks, and those would cancel out the commits the child really
 * holds. `cache`, when given, memoises per (head, main, branch).
 */
export function heldCommitsOf(head, { mainSide, branchSide, cwd, cache = null }) {
  const key = `${head}:${mainSide}:${branchSide}`;
  if (cache?.has(key)) return cache.get(key);
  const notOnBase = countRange(head, [mainSide], cwd);
  const onNeither = countRange(head, [mainSide, branchSide], cwd);
  const held = notOnBase - onNeither > 0;
  cache?.set(key, held);
  return held;
}

/**
 * Two open heads form a stack when either holds commits of the other that the
 * base does not: an ad-hoc stack retargeted to the base, or a branch cut from
 * another open branch. Tested in both directions.
 */
export const isStackedPair = (a, b, { mainSide, cwd, cache = null }) =>
  heldCommitsOf(b, { mainSide, branchSide: a, cwd, cache }) || heldCommitsOf(a, { mainSide, branchSide: b, cwd, cache });
