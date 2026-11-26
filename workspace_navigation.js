/* Pure route / navigation state for one board's view. No DOM, history, localStorage or board storage.
 *
 * Identity (board / project / view) is the outer route and is only passed through by read().
 * The view state is what presentation / root / panel / focusCard / canvasScope describe:
 *   presentation  "cards" | "mindmap" | "research"
 *   panel         research tab ("board" | "structure" | ...); only written in research
 *   canvasBranch  canvas branch root (cards / mindmap); null = whole board.   URL: root
 *   readingRoot   reading root (research); "board" = the virtual whole-board root.   URL: root
 *   card          current card.   URL: focusCard (legacy: #E27)
 *   returnBranch  branch the canvas returns to; undefined = none, null = whole board.   URL: canvasScope
 * Invariants: research has no canvasBranch; cards / mindmap have no readingRoot or returnBranch.
 * Collapsed folds, positions and board revisions are never part of this state.
 *
 * transition(state, action, context): context.nodes is [{ id, parentId, category? }] for the live tree.
 * Nothing here assumes a shallow tree; ancestor walks are iterative and cycle-safe. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WorkspaceNavigation = api;
})(typeof window === "object" ? window : null, () => {
  "use strict";
  const PRESENTATIONS = Object.freeze(["cards", "mindmap", "research"]);
  const PANELS = Object.freeze(["structure", "board", "flow", "graph", "comparison", "evidence", "atlas"]);
  const ROUTE_KEYS = ["presentation", "root", "panel", "focusCard", "canvasScope"];
  const VIRTUAL = "board";
  const ID = /^[A-Za-z0-9][\w.:-]{0,127}$/u;
  const CARD_HASH = /^#([EA]\d+)$/u;

  const cleanId = value => typeof value === "string" && ID.test(value) ? value : null;
  const realId = value => { const id = cleanId(value); return id === VIRTUAL ? null : id; };

  function make(fields = {}) {
    const research = fields.presentation === "research";
    const presentation = PRESENTATIONS.includes(fields.presentation) ? fields.presentation : "cards";
    return Object.freeze({
      presentation,
      panel: research && PANELS.includes(fields.panel) ? fields.panel : "board",
      canvasBranch: research ? null : realId(fields.canvasBranch),
      readingRoot: research ? cleanId(fields.readingRoot) : null,
      card: realId(fields.card),
      returnBranch: !research || fields.returnBranch === undefined ? undefined : realId(fields.returnBranch),
    });
  }
  const same = (a, b) => Object.keys(a).every(key => a[key] === b[key]);

  function split(url) {
    const text = String(url ?? "");
    const hashAt = text.indexOf("#");
    const head = hashAt < 0 ? text : text.slice(0, hashAt);
    const queryAt = head.indexOf("?");
    return { prefix: queryAt < 0 ? head : head.slice(0, queryAt),
      params: new URLSearchParams(queryAt < 0 ? "" : head.slice(queryAt + 1)),
      hash: hashAt < 0 ? "" : text.slice(hashAt) };
  }

  /* url: string, URL or Location. Returns { identity, state, explicit }.
   * explicit is false when the URL has no valid presentation, so the caller knows defaultPresentation was used. */
  function read(url, defaultPresentation = "cards") {
    const { params, hash } = split(url);
    const requested = params.get("presentation");
    const explicit = PRESENTATIONS.includes(requested);
    const presentation = explicit ? requested : PRESENTATIONS.includes(defaultPresentation) ? defaultPresentation : "cards";
    const hashCard = CARD_HASH.exec(hash)?.[1] ?? null;
    const root = cleanId(params.get("root"));
    const scope = params.get("canvasScope");
    return {
      identity: { board: params.get("board"), project: params.get("project"), view: params.get("view") },
      explicit,
      state: make({
        presentation,
        panel: params.get("panel"),
        canvasBranch: root,
        readingRoot: root ?? hashCard,
        card: cleanId(params.get("focusCard")) ?? hashCard,
        returnBranch: scope === null ? undefined : scope === VIRTUAL ? null : cleanId(scope) ?? undefined,
      }),
    };
  }

  /* Returns the URL string with only the route keys replaced. Other parameters keep their values;
   * a legacy #E27 hash is consumed (the card is in the state), any other hash is kept. */
  function write(url, state) {
    const { prefix, params, hash } = split(url);
    const value = make(state);
    for (const key of ROUTE_KEYS) params.delete(key);
    const research = value.presentation === "research";
    params.set("presentation", value.presentation);
    const root = research ? value.readingRoot : value.canvasBranch;
    if (root) params.set("root", root);
    if (research && value.panel !== "board") params.set("panel", value.panel);
    if (value.card) params.set("focusCard", value.card);
    if (research && value.returnBranch !== undefined) params.set("canvasScope", value.returnBranch ?? VIRTUAL);
    const query = params.toString();
    return prefix + (query ? `?${query}` : "") + (CARD_HASH.test(hash) ? "" : hash);
  }

  function tree(nodes) {
    const parent = new Map();
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const id = cleanId(node?.id);
      if (!id || id === VIRTUAL || node.category === "archive") continue;
      parent.set(id, typeof node.parentId === "string" ? node.parentId : null);
    }
    const up = id => parent.has(parent.get(id)) ? parent.get(id) : null;
    const roots = [...parent.keys()].filter(id => up(id) === null);
    const chain = id => { // id, its parent, ... up to the root; stops at a cycle
      const out = [];
      const seen = new Set();
      for (let current = id; parent.has(current) && !seen.has(current); current = up(current)) {
        seen.add(current);
        out.push(current);
      }
      return out;
    };
    return {
      has: id => parent.has(id),
      virtual: roots.length >= 2,
      chain,
      /* A branch shows its root and descendants, so it contains the cards whose chain includes it. */
      contains: (branch, card) => branch === null || chain(card).includes(branch),
      /* The start branch, else its nearest ancestor, that contains card; null (whole board) if none. */
      nearest(start, card) {
        const cardChain = new Set(chain(card));
        return chain(start).find(id => cardChain.has(id)) ?? null;
      },
      survivor: ids => [...ids].reverse().find(id => parent.has(id)) ?? null,
    };
  }

  /* The card a surface action refers to: structure shows the focus card, other reading panels show the root. */
  function currentCard(state, canvasCard = null) {
    const value = make(state);
    if (value.presentation !== "research") return realId(canvasCard) ?? value.card;
    return value.panel === "structure" ? value.card : realId(value.readingRoot);
  }

  /* Which canvas branch to return to for card, from state's own return / root. */
  function resolveCanvas(from, card, t) {
    const target = card && t.has(card) ? card : null;
    const research = from.presentation === "research";
    const base = from.returnBranch !== undefined ? from.returnBranch : research ? realId(from.readingRoot) : from.canvasBranch;
    if (base === null) return { branch: null, target };
    let branch = target ? t.nearest(base, target) : t.has(base) ? base : null;
    if (target && branch === null) {
      const reading = research ? realId(from.readingRoot) : null;
      if (reading && t.contains(reading, target)) branch = reading;
    }
    return { branch, target };
  }

  /* Actions (context.nodes needed where a card id is checked):
   *   setPresentation { presentation }      cards / mindmap / research buttons
   *   showCanvas { card? }                  "项目画布" / 在画布定位 / 编辑画布 (old showCanvasAt); context.canvasCard
   *   showStructure                         "项目结构" (old showStructure); context.structureRoot, context.canvasCard
   *   enterReading { root, panel? }         open a reading root (old enter)
   *   openBranch { branch, focus? }         enter a canvas branch, optionally select its root
   *   focusCard { card }                    make a card current (a canvas branch not containing it moves to an ancestor)
   *   setPanel { panel }                    research tab
   *   reconcile                             drop ids that no longer exist; context.lastPath, context.availablePanels
   * Returns the same state object when nothing changes. */
  function transition(state, action, context = {}) {
    const from = make(state);
    const t = tree(context.nodes);
    const research = from.presentation === "research";
    const next = (() => {
      switch (action?.type) {
        case "setPresentation": {
          const to = action.presentation;
          if (!PRESENTATIONS.includes(to) || to === from.presentation) return from;
          if (to === "research") return make({ ...from, presentation: to, readingRoot: from.canvasBranch, returnBranch: from.canvasBranch });
          if (!research) return make({ ...from, presentation: to });
          const { branch, target } = resolveCanvas(from, from.card ?? currentCard(from), t);
          return make({ ...from, presentation: to, canvasBranch: branch, card: from.card && target });
        }
        case "showCanvas": {
          const card = action.card !== undefined ? action.card : currentCard(from, context.canvasCard);
          const { branch, target } = resolveCanvas(from, card, t);
          return make({ ...from, presentation: "cards", canvasBranch: branch, card: target });
        }
        case "showStructure": {
          const structureRoot = cleanId(context.structureRoot);
          if (!structureRoot || !(structureRoot === VIRTUAL ? t.virtual : t.has(structureRoot)) ||
              (research && from.panel === "structure" && from.readingRoot === structureRoot)) return from;
          return make({ ...from, presentation: "research", panel: "structure", readingRoot: structureRoot,
            card: research ? realId(from.readingRoot) : realId(context.canvasCard) ?? from.card,
            returnBranch: research ? from.returnBranch : from.canvasBranch });
        }
        case "enterReading": {
          const root = cleanId(action.root);
          if (!root || !(root === VIRTUAL ? t.virtual : t.has(root))) return from;
          return make({ ...from, presentation: "research", panel: action.panel ?? "board", readingRoot: root,
            card: t.has(action.card) ? action.card : null,
            returnBranch: research ? from.returnBranch : from.canvasBranch });
        }
        case "openBranch": {
          const branch = realId(action.branch);
          const canvasBranch = branch && t.has(branch) ? branch : null;
          return make({ ...from, presentation: "cards", canvasBranch, card: action.focus ? canvasBranch : null });
        }
        case "focusCard": {
          if (action.card == null) return make({ ...from, card: null });
          const card = realId(action.card);
          if (!card || !t.has(card)) return from;
          return research ? make({ ...from, card })
            : make({ ...from, card, canvasBranch: t.nearest(from.canvasBranch, card) });
        }
        case "setPanel":
          return research && PANELS.includes(action.panel) ? make({ ...from, panel: action.panel }) : from;
        case "reconcile": {
          const path = Array.isArray(context.lastPath) ? context.lastPath.filter(id => typeof id === "string") : [];
          const reading = from.readingRoot === VIRTUAL ? (t.virtual ? VIRTUAL : null) : from.readingRoot;
          const available = !Array.isArray(context.availablePanels) || context.availablePanels.includes(from.panel);
          const card = from.card !== null && t.has(from.card) ? from.card : null;
          const branch = from.canvasBranch === null || t.has(from.canvasBranch) ? from.canvasBranch : t.survivor(path);
          return make({ ...from,
            panel: available ? from.panel : "board",
            readingRoot: reading === null || reading === VIRTUAL || t.has(reading) ? reading : t.survivor(path),
            canvasBranch: card ? t.nearest(branch, card) : branch,
            card,
            returnBranch: from.returnBranch === undefined || from.returnBranch === null || t.has(from.returnBranch)
              ? from.returnBranch : undefined });
        }
        default:
          throw new TypeError(`Unknown navigation action: ${action?.type}`);
      }
    })();
    if (!same(from, next)) return next;
    return state && same(from, state) ? state : from;
  }

  return { read, write, transition, currentCard, PRESENTATIONS, PANELS };
});
