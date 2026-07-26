const STORED_ISO_OWNER_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export const normalizeStoredIsoOwnerId = (value) => {
  const ownerId = String(value || "").trim();
  return STORED_ISO_OWNER_PATTERN.test(ownerId) ? ownerId : "";
};

export const storedIsosForOwner = (items, ownerId) => {
  const normalizedOwnerId = normalizeStoredIsoOwnerId(ownerId);
  if (!normalizedOwnerId || !Array.isArray(items)) return [];
  return items.filter((item) => normalizeStoredIsoOwnerId(item?.ownerId) === normalizedOwnerId);
};
