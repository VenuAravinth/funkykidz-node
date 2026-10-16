import { makeTaxonomyModel } from "./taxonomy.model.js";

// Brands (`brands` collection). Products reference them by `brandId` and keep the name in `brand`.
export const Brand = makeTaxonomyModel("brands");
