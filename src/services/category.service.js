import { Category } from "../models/category.model.js";
import { makeTaxonomyService } from "./taxonomy.service.js";

export const CategoryService = makeTaxonomyService({ model: Category, label: "Category", idField: "categoryId", nameField: "category" });
