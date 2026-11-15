(() => {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const stopWords = new Set(("我 你 它 的 了 吗 呢 啊 是 有 在 用 做 想 能 把 和 或 跟 及 给 找 找到 " +
    "请 帮 一下 帮忙 一些 一个 哪 哪个 哪些 哪儿 哪里 什么 怎么 怎样 如何 之前 以前 最近 本机 电脑 上面 " +
    "那 那个 这 这个 那套 这套 哪套 一套 项目 工程 代码 目录 文件 文件夹 查看 看看 打开 有没有 可以 能否 能不能 想要 " +
    "需要 相关 关于 用来 用于 适合 能做 我想 知道 帮我 找找 哪一个 the a an to of for find project").split(" "));

  function normalize(value) {
    return value.normalize("NFKC").toLowerCase().replaceAll("\\", "/").trim();
  }

  function termsOf(question) {
    return [...new Set(Array.from(segmenter.segment(question), ({ segment, isWordLike }) =>
      isWordLike ? segment : "").filter((term) => term && !stopWords.has(term)))];
  }

  function containsPhrase(phrase) {
    if (/^[a-z0-9_]+$/u.test(phrase)) {
      const pattern = new RegExp(`(?<![a-z0-9_])${phrase}(?![a-z0-9_])`, "u");
      return (text) => pattern.test(text);
    }
    return (text) => text.includes(phrase);
  }

  function findProjects(projects, question) {
    const query = normalize(question);
    if (!query) return [];
    const terms = termsOf(query);
    const entries = projects.map((project) => ({
      project,
      name: normalize(project.name),
      path: normalize(project.path),
      aliases: (project.aliases || []).map(normalize),
      description: normalize(project.description),
      category: normalize(project.category),
      score: 0,
      hasMatch: false,
    }));

    for (const term of terms) {
      const contains = containsPhrase(term);
      const matches = entries.map((entry) => ({ entry, weight: termWeight(entry, contains) }));
      const frequency = matches.filter(({ weight }) => weight > 0).length;
      if (!frequency) continue;
      const rarity = 1 + Math.log((entries.length + 1) / (frequency + 1));
      for (const { entry, weight } of matches) {
        entry.score += weight * rarity * (term.length === 1 ? 0.32 : 1);
        entry.hasMatch ||= weight > 0 && (term.length > 1 || entry.aliases.includes(term));
      }
    }

    for (const entry of entries) {
      const named = entry.name.length >= 3 && containsPhrase(entry.name)(query);
      const path = query === entry.path || (entry.path.length >= 4 && query.includes(entry.path));
      const phraseLength = Math.max(0, ...entry.aliases.filter((alias) => alias.length >= 2 && containsPhrase(alias)(query))
        .map((alias) => alias.length));
      if (named || path || phraseLength) {
        entry.hasMatch = true;
        entry.score += named || path ? 30 : 8 + Math.min(phraseLength, 10) * 2;
      }
    }

    const ranked = entries.filter(({ hasMatch, score }) => hasMatch && score >= 4)
      .sort((a, b) => b.score - a.score);
    const topScore = ranked[0]?.score || 0;
    return ranked.filter(({ score }) => score >= topScore * 0.55)
      .slice(0, 3).map(({ project }) => project);
  }

  function termWeight(entry, contains) {
    if (contains(entry.name)) return 6;
    if (entry.aliases.some(contains)) return 5;
    if (contains(entry.path)) return 3;
    if (contains(entry.description)) return 2;
    if (contains(entry.category)) return 1;
    return 0;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { findProjects };
  else window.WhiteboardProjectFinder = { findProjects };
})();
