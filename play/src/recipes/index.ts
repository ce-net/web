/** The ordered recipe registry the picker renders. Mirrors the cookbook (M5). */

import type { Recipe } from "../recipe.js";
import { statusRecipe } from "./status.js";
import { blocksRecipe } from "./blocks.js";
import { txnsRecipe } from "./txns.js";
import { blobRecipe } from "./blob.js";
import { transferRecipe } from "./transfer.js";
import { meshRecipe } from "./mesh.js";
import { jobRecipe } from "./job.js";
import { atlasRecipe } from "./atlas.js";

export const RECIPES: Recipe[] = [
  statusRecipe,
  blocksRecipe,
  txnsRecipe,
  blobRecipe,
  transferRecipe,
  meshRecipe,
  jobRecipe,
  atlasRecipe,
];

export function findRecipe(id: string | null): Recipe {
  if (id) {
    const hit = RECIPES.find((r) => r.id === id);
    if (hit) return hit;
  }
  return RECIPES[0]!;
}
