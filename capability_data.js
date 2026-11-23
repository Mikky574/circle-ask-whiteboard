/* A capability describes observable use. Repository evidence is stored separately. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CapabilityData = api;
})(typeof window === "object" ? window : null, () => {
  "use strict";
  const fields = ["audience", "input", "outcome", "boundary", "verification"];
  function validate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
        Object.keys(value).some(key => key !== "version" && !fields.includes(key))) {
      throw new Error("功能说明结构无效。");
    }
    const record = { version: 1 };
    for (const field of fields) {
      const entry = value[field];
      if (typeof entry !== "string" || !entry.trim() || Array.from(entry).length > 200 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u.test(entry)) {
        throw new Error("功能说明需要使用者、输入、结果、边界和核对方式，每项最多 200 字。");
      }
      record[field] = entry.trim();
    }
    return record;
  }
  function clean(value) {
    if (value == null) return null;
    try { return validate(value); } catch { return null; }
  }
  return { validate, clean };
});
