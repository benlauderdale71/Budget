export const assetProfiles = {
  general: { label: "General item", fields: ["Model number", "Edition", "Size", "Included accessories"] },
  watch: { label: "Watch", fields: ["Reference number", "Dial", "Case material", "Box and papers", "Service history"] },
  car: { label: "Car or truck", fields: ["Model year", "Trim", "Mileage", "Drivetrain", "Title status", "Market region"] },
  atv: { label: "ATV or side-by-side", fields: ["Model year", "Trim", "Engine size", "Engine hours", "Mileage", "Market region"] },
  boat: { label: "Boat or watercraft", fields: ["Model year", "Hull identification number", "Engine model", "Engine hours", "Length", "Trailer included", "Market region"] },
  motorcycle: { label: "Motorcycle", fields: ["Model year", "Trim", "Engine size", "Mileage", "Market region"] },
  coin: { label: "Coin", fields: ["Country", "Denomination", "Year", "Mint mark", "Variety or catalog number", "Grade", "Certification number", "Numista type ID", "Numista issue ID"] },
  banknote: { label: "Banknote", fields: ["Country", "Issuer", "Denomination", "Series year", "Pick number", "Grade", "Certification number", "Face currency", "Face amount", "Numista type ID", "Numista issue ID"] },
  sports_card: { label: "Sports card", fields: ["Player", "Year", "Set", "Card number", "Parallel", "Grade", "Certification number", "Print run", "SportsCardsPro ID"] },
  camera: { label: "Camera or lens", fields: ["Model number", "Lens mount", "Focal length", "Aperture", "Shutter count", "Included accessories"] },
  accessory: { label: "Accessory", fields: ["Model number", "Compatibility", "Size", "Version", "Included accessories"] },
  private_appraisal: { label: "Private appraisal or regulated item", fields: ["Model number", "Appraisal reference"] },
} as const;

export type AssetProfile = keyof typeof assetProfiles;
export const assetProfileKeys = Object.keys(assetProfiles) as [AssetProfile, ...AssetProfile[]];
export type AssetAttribute = { label: string; value: string };
export type AssetIdentity = { profile: AssetProfile; attributes: AssetAttribute[] };
export type PhotoRegion = { x: number; y: number; width: number; height: number };

export const inventoryCategories = [
  "Vehicles", "ATVs & powersports", "Boats", "Motorcycles", "Real estate", "Electronics",
  "Cameras & lenses", "Accessories", "Furniture", "Appliances", "Tools & equipment",
  "Jewelry & watches", "Collectibles & art", "Coins", "Banknotes", "Sports cards",
  "Sports & outdoors", "Private appraisal", "Other",
];

export function profileForCategory(category: string): AssetProfile {
  switch (category.toLowerCase().trim()) {
    case "vehicles": return "car";
    case "atvs & powersports": return "atv";
    case "boats": return "boat";
    case "motorcycles": return "motorcycle";
    case "coins": return "coin";
    case "banknotes": return "banknote";
    case "sports cards": return "sports_card";
    case "cameras & lenses": return "camera";
    case "accessories": return "accessory";
    case "jewelry & watches": return "watch";
    case "private appraisal": return "private_appraisal";
    default: return "general";
  }
}

export function privateAppraisalOnly(profile: AssetProfile, description: string) {
  const phrase=description.replace(/\b(?:glue|heat|paint|paintball|staple|caulking|spray|massage|water|toy|foam|nail|grease) guns?\b/gi, "");
  return profile === "private_appraisal" || /\b(guns?|firearms?|(?:hand|shot)guns?|pistols?|revolvers?|rifles?|ammunition|suppressors?|ar[- ]?15|ak[- ]?47|glock)\b/i.test(phrase);
}

export function attribute(assets: readonly AssetAttribute[], label: string) {
  return assets.find(item => item.label.toLowerCase() === label.toLowerCase())?.value ?? "";
}

const comparableFields: Partial<Record<AssetProfile, readonly string[]>> = {
  watch: ["Reference number", "Dial", "Case material"],
  car: ["Model year", "Trim", "Drivetrain"],
  atv: ["Model year", "Trim", "Engine size"],
  boat: ["Model year", "Engine model", "Length"],
  motorcycle: ["Model year", "Trim", "Engine size"],
  coin: ["Country", "Denomination", "Year", "Mint mark", "Variety or catalog number", "Grade"],
  banknote: ["Country", "Denomination", "Series year", "Pick number", "Grade"],
  sports_card: ["Player", "Year", "Set", "Card number", "Parallel", "Grade"],
  camera: ["Model number", "Lens mount", "Focal length", "Aperture"],
  accessory: ["Model number", "Compatibility", "Version"],
  general: ["Model number", "Edition", "Size"],
};

const identityRequirements: Partial<Record<AssetProfile, readonly string[]>> = {
  watch:["Reference number"],
  coin:["Country","Denomination","Year","Grade"],
  banknote:["Country","Denomination","Pick number","Grade"],
  sports_card:["Year","Set","Card number","Grade"],
  atv:["Model year"], boat:["Model year"], motorcycle:["Model year"],
};
export function requiredComparableDetails(profile:AssetProfile, attributes:readonly AssetAttribute[]) {
  return (identityRequirements[profile] ?? []).filter(label=>!attribute(attributes,label).trim());
}

export function comparableTerms(profile: AssetProfile, attributes: readonly AssetAttribute[]) {
  return (comparableFields[profile] ?? []).map(label => attribute(attributes, label)).filter(Boolean);
}
