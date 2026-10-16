import { Brand } from "../models/brand.model.js";
import { makeTaxonomyService } from "./taxonomy.service.js";

export const BrandService = makeTaxonomyService({ model: Brand, label: "Brand", idField: "brandId", nameField: "brand" });
