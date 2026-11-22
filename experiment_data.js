/* Structured experiment records are part of a card's portable document. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExperimentData = api;
})(typeof window === "object" ? window : null, () => {
  "use strict";
  const fields = ["kind", "question", "metricSummary", "finding", "caveat"];
  function text(value, limit = 800) {
    if (typeof value !== "string" || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
      throw new Error("实验说明必须是有效文本。");
    }
    return value.trim();
  }
  function validate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
      throw new Error("实验资料版本无效。");
    }
    const result = { version: 1 };
    for (const field of fields) if (field in value) result[field] = text(value[field]);
    if (value.comparison != null) {
      const comparison = value.comparison;
      if (!comparison || typeof comparison !== "object" ||
          !Array.isArray(comparison.metrics) || !comparison.metrics.length || comparison.metrics.length > 6 ||
          !Array.isArray(comparison.arms) || comparison.arms.length < 2 || comparison.arms.length > 12) {
        throw new Error("实验对照需要 1–6 个指标和 2–12 个对照臂。");
      }
      const metrics = comparison.metrics.map(metric => {
        if (!metric || !["higher", "lower"].includes(metric.direction)) throw new Error("实验指标方向无效。");
        const label = text(metric.label, 100);
        if (!label) throw new Error("实验指标名称不能为空。");
        return { label, direction: metric.direction };
      });
      const arms = comparison.arms.map(arm => {
        if (!arm || typeof arm.id !== "string" || !/^[a-zA-Z0-9_-]{1,60}$/.test(arm.id) || !Array.isArray(arm.values) ||
            arm.values.length !== metrics.length ||
            arm.values.some(number => number !== null && (typeof number !== "number" || !Number.isFinite(number)))) {
          throw new Error("实验对照数值无效，缺失值请用 null。");
        }
        const label = text(arm.label, 100);
        if (!label) throw new Error("对照方法名称不能为空。");
        return { id: arm.id, label, values: [...arm.values] };
      });
      if (new Set(arms.map(arm => arm.id)).size !== arms.length ||
          !arms.some(arm => arm.id === comparison.baseline) ||
          !arms.some(arm => arm.id === comparison.primary) || comparison.baseline === comparison.primary) {
        throw new Error("实验基线或主对照臂无效。");
      }
      result.comparison = { metrics, arms, baseline: comparison.baseline, primary: comparison.primary };
      for (const field of ["title", "cohort", "source", "finding", "caveat"]) {
        if (field in comparison) result.comparison[field] = text(comparison[field], 1200);
      }
    }
    return result;
  }
  function clean(value) {
    if (value == null) return null;
    try { return validate(value); } catch { return null; }
  }
  return { validate, clean };
});
