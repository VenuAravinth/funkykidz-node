import { makeTaxonomyModel } from "./taxonomy.model.js";

// Product categories (`categories` collection). Products reference them by `categoryId` and keep
// the name in `category` for the website.
export const Category = makeTaxonomyModel("categories");
