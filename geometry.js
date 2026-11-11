(() => {
  const EPSILON = 1e-7;
  const sectionColumnThreshold = 4;

  function scenePoint(clientX, clientY, boardRect, scale) {
    return {
      x: (clientX - boardRect.x) / scale,
      y: (clientY - boardRect.y) / scale,
    };
  }

  function bounds(points) {
    if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

    let { x: minX, y: minY } = points[0];
    let maxX = minX;
    let maxY = minY;
    for (const { x, y } of points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function contains(point, polygon) {
    if (polygon.length < 3) return false;

    let inside = false;
    let previous = polygon[polygon.length - 1];
    for (const current of polygon) {
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      const cross = dx * (point.y - previous.y) - dy * (point.x - previous.x);
      if (Math.abs(cross) <= EPSILON * Math.max(1, Math.hypot(dx, dy)) &&
          point.x >= Math.min(previous.x, current.x) - EPSILON &&
          point.x <= Math.max(previous.x, current.x) + EPSILON &&
          point.y >= Math.min(previous.y, current.y) - EPSILON &&
          point.y <= Math.max(previous.y, current.y) + EPSILON) {
        return true;
      }
      if ((previous.y > point.y) !== (current.y > point.y) &&
          point.x < previous.x + (point.y - previous.y) * dx / dy) {
        inside = !inside;
      }
      previous = current;
    }
    return inside;
  }

  function intersectsShape(rect, polygon) {
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    if (contains(center, polygon)) return true;

    let hits = 0;
    for (const x of [rect.x, center.x, rect.x + rect.width]) {
      for (const y of [rect.y, center.y, rect.y + rect.height]) {
        if (contains({ x, y }, polygon)) hits += 1;
      }
    }
    return hits >= 5;
  }

  function isLasso(points) {
    const minimumSpan = 6;
    const minimumArea = 24;
    if (points.length < 3) return false;

    const { x, y, width, height } = bounds(points);
    if (width < minimumSpan || height < minimumSpan) return false;

    let twiceArea = 0;
    let previous = points[points.length - 1];
    for (const current of points) {
      twiceArea += (previous.x - x) * (current.y - y) - (previous.y - y) * (current.x - x);
      previous = current;
    }
    return Math.abs(twiceArea) >= minimumArea * 2;
  }

  function placeNote(anchor, occupied, size, previous, gap = 24, { below = false } = {}) {
    const blockers = [anchor, ...occupied];
    if (previous && (!below || previous.y >= anchor.y + anchor.height + gap) && blockers.every((rect) =>
      previous.x + size.width + gap <= rect.x || rect.x + rect.width + gap <= previous.x ||
      previous.y + size.height + gap <= rect.y || rect.y + rect.height + gap <= previous.y)) {
      return { ...size, ...previous };
    }

    let best;
    let bestDistance = Infinity;
    const directions = [
      ["y", "x", "height", "width", 1],
      ["x", "y", "width", "height", 1],
      ["x", "y", "width", "height", -1],
      ["y", "x", "height", "width", -1],
    ];
    for (const [axis, parallel, extent, span, direction] of below ? directions.slice(0, 1) : directions) {
      const start = (direction > 0 ? anchor[axis] + anchor[extent] : -anchor[axis]) + gap;
      const intervals = blockers.map((rect) => ({
        start: (direction > 0 ? rect[axis] : -rect[axis] - rect[extent]) - gap,
        end: (direction > 0 ? rect[axis] + rect[extent] : -rect[axis]) + gap,
        low: rect[parallel] - gap,
        high: rect[parallel] + rect[span] + gap,
      })).sort((a, b) => a.start - b.start);
      const centered = below ? (anchor[span] - size[span]) / 2 : 0;
      const preferred = anchor[parallel] + centered;
      const alignments = new Set([preferred]);
      for (const { low, high } of intervals) {
        alignments.add(low - size[span]);
        alignments.add(high);
      }
      for (const alignment of alignments) {
        const shift = (alignment - preferred) ** 2;
        if (shift >= bestDistance) continue;
        let position = start;
        // Move outward until the note clears all intervals on this alignment.
        for (const interval of intervals) {
          if (position + size[extent] <= interval.start) break;
          if (alignment < interval.high && alignment + size[span] > interval.low) {
            position = Math.max(position, interval.end);
          }
        }
        const distance = shift + (position - start) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { ...size, [axis]: direction > 0 ? position : -position - size[extent], [parallel]: alignment };
        }
      }
      if (bestDistance === 0) break;
    }
    return best;
  }

  function placeNoteGroup(anchor, occupied, sizes, previous, gap, columns = 2, { below = true } = {}) {
    let leftWidth = 0;
    let rightWidth = 0;
    for (const [index, size] of sizes.entries()) {
      if (index % columns === 0) leftWidth = Math.max(leftWidth, size.width);
      else rightWidth = Math.max(rightWidth, size.width);
    }
    const width = leftWidth + (rightWidth ? gap + rightWidth : 0);
    const slots = [];
    let top = 0;
    for (let index = 0; index < sizes.length; index += columns) {
      const left = sizes[index];
      const right = columns === 2 ? sizes[index + 1] : null;
      slots.push({ ...left, x: 0, y: top });
      if (right) slots.push({ ...right, x: leftWidth + gap, y: top });
      top += Math.max(left.height, right?.height || 0) + gap;
    }
    const height = top - gap;
    const group = placeNote(anchor, occupied, { width, height }, previous, gap, { below });
    const left = !below && group.x + width <= anchor.x;
    const above = !below && group.y + height <= anchor.y;
    return slots.map((slot) => ({
      ...slot,
      x: group.x + (left ? width - slot.x - slot.width : slot.x),
      y: group.y + (above ? height - slot.y - slot.height : slot.y),
    }));
  }

  function routeAcrossCards(parent, child, rectangles) {
    const direction = child.x >= parent.x + parent.width ? 1 :
      parent.x >= child.x + child.width ? -1 : 0;
    if (!direction) return null;

    const startX = direction > 0 ? parent.x + parent.width : parent.x;
    const endX = direction > 0 ? child.x : child.x + child.width;
    const gap = Math.abs(endX - startX);
    if (!gap) return null;

    const startY = parent.y + parent.height / 2;
    const endY = child.y + child.height / 2;
    const clearance = 3;
    const overlaps = (a, b, min, max) =>
      Math.min(a, b) < max + clearance && Math.max(a, b) > min - clearance;
    const blockers = [...rectangles].filter((rect) => rect !== parent && rect !== child &&
      overlaps(startX, endX, rect.x, rect.x + rect.width));
    if (!blockers.some((rect) => overlaps(startY, endY, rect.y, rect.y + rect.height))) return null;

    const channels = new Set([startY, endY]);
    for (const rect of blockers) {
      channels.add(rect.y - 14);
      channels.add(rect.y + rect.height + 14);
    }

    const gutters = [...new Set([14, 7, 22].map((width) => Math.min(width, gap / 3)))];
    let best = null;
    let shortest = Infinity;
    for (const channelY of channels) {
      const distance = Math.abs(channelY - startY) + Math.abs(channelY - endY);
      if (distance >= shortest) continue;
      for (const startGutter of gutters) {
        for (const endGutter of gutters) {
          const firstX = startX + direction * startGutter;
          const lastX = endX - direction * endGutter;
          const points = [[startX, startY], [firstX, startY], [firstX, channelY],
            [lastX, channelY], [lastX, endY], [endX, endY]];
          const blocked = points.slice(1).some(([x, y], index) => {
            const [previousX, previousY] = points[index];
            return blockers.some((rect) => overlaps(previousX, x, rect.x, rect.x + rect.width) &&
              overlaps(previousY, y, rect.y, rect.y + rect.height));
          });
          if (!blocked) {
            best = `M${startX},${startY} H${firstX} V${channelY} H${lastX} V${endY} H${endX}`;
            shortest = distance;
            break;
          }
        }
        if (distance === shortest) break;
      }
    }
    return best;
  }

  function clearOrthogonalPath(points, rectangles) {
    const clearance = 2;
    for (let index = 1; index < points.length; index++) {
      const [x, y] = points[index];
      const [previousX, previousY] = points[index - 1];
      if (rectangles.some((rect) =>
        Math.min(x, previousX) < rect.x + rect.width + clearance &&
        Math.max(x, previousX) > rect.x - clearance &&
        Math.min(y, previousY) < rect.y + rect.height + clearance &&
        Math.max(y, previousY) > rect.y - clearance)) return false;
    }
    return true;
  }

  function orthogonalSegments(points) {
    const segments = [];
    for (let index = 1; index < points.length; index++) {
      const [x, y] = points[index];
      const [previousX, previousY] = points[index - 1];
      if (x !== previousX) segments.push({ axis: "x", rail: y, start: Math.min(x, previousX), end: Math.max(x, previousX) });
      else if (y !== previousY) segments.push({ axis: "y", rail: x, start: Math.min(y, previousY), end: Math.max(y, previousY) });
    }
    return segments;
  }

  function routeAroundCards(parent, child, rectangles, axis, preferred, otherRails) {
    const gap = 8;
    const obstacles = rectangles.filter((rect) => rect !== parent && rect !== child);
    const sharedLength = (segments) => segments.reduce((total, segment) => total + otherRails.reduce((overlap, other) =>
      overlap + (segment.axis === other.axis && Math.abs(segment.rail - other.rail) < 6
        ? Math.max(0, Math.min(segment.end, other.end) - Math.max(segment.start, other.start)) : 0), 0), 0);
    let best = null;
    let bestCost = Infinity;
    if (preferred && clearOrthogonalPath(preferred, obstacles)) {
      const segments = orthogonalSegments(preferred);
      const shared = sharedLength(segments);
      if (shared <= 16) return preferred;
      best = preferred;
      bestCost = segments.reduce((total, { start, end }) => total + end - start, 0) + shared;
    }
    const ports = (rect, toward) => {
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const distance = axis === "x" ? toward.x + toward.width / 2 - x : toward.y + toward.height / 2 - y;
      const direction = Math.sign(distance) || 1;
      const blockers = [...obstacles, toward];
      return [
        { side: "x", sign: -1, edge: [rect.x, y], stub: [rect.x - gap, y] },
        { side: "x", sign: 1, edge: [rect.x + rect.width, y], stub: [rect.x + rect.width + gap, y] },
        { side: "y", sign: -1, edge: [x, rect.y], stub: [x, rect.y - gap] },
        { side: "y", sign: 1, edge: [x, rect.y + rect.height], stub: [x, rect.y + rect.height + gap] },
      ].filter(({ edge, stub }) => clearOrthogonalPath([edge, stub], blockers))
        .map((port) => ({ ...port, penalty: port.side !== axis ? 16 : port.sign !== direction ? 24 : 0 }));
    };
    const from = ports(parent, child);
    const to = ports(child, parent);
    const channels = (axis) => {
      const extent = axis === "x" ? "width" : "height";
      const result = new Set(rectangles.flatMap((rect) => [rect[axis] - gap, rect[axis] + rect[extent] + gap]));
      for (const { axis: direction, rail } of otherRails) {
        if (direction === axis) continue;
        result.add(rail - 6);
        result.add(rail + 6);
      }
      return result;
    };
    const channelsX = channels("x");
    const channelsY = channels("y");
    for (const start of from) {
      for (const end of to) {
        const [x, y] = start.stub;
        const [targetX, targetY] = end.stub;
        const tryRoute = (bends) => {
          const points = [start.stub, ...bends, end.stub];
          const distance = points.slice(1).reduce((total, [nextX, nextY], index) =>
            total + Math.abs(nextX - points[index][0]) + Math.abs(nextY - points[index][1]), 0);
          let cost = distance + 2 * gap + 12 * bends.length + start.penalty + end.penalty;
          if (cost >= bestCost || !clearOrthogonalPath(points, rectangles)) return;
          const route = [start.edge, ...points, end.edge];
          cost += sharedLength(orthogonalSegments(route));
          if (cost >= bestCost) return;
          bestCost = cost;
          best = route;
        };
        if (x === targetX || y === targetY) tryRoute([]);
        tryRoute([[targetX, y]]);
        tryRoute([[x, targetY]]);
        for (const rail of channelsX) tryRoute([[rail, y], [rail, targetY]]);
        for (const rail of channelsY) tryRoute([[x, rail], [targetX, rail]]);
      }
    }
    return best;
  }

  function sharedBranchRoutes(parent, children, rectangles, axis) {
    const horizontal = axis === "x";
    const along = horizontal ? "x" : "y";
    const across = horizontal ? "y" : "x";
    const length = horizontal ? "width" : "height";
    const breadth = horizontal ? "height" : "width";
    const clearance = 2;
    const parentCenter = parent[across] + parent[breadth] / 2;
    const point = (a, b) => horizontal ? `${a},${b}` : `${b},${a}`;
    const segment = (a, b, c, d) => `M${point(a, b)} L${point(c, d)}`;
    const overlaps = (a, b, start, size) =>
      Math.max(a, b) > start - clearance && Math.min(a, b) < start + size + clearance;
    const clear = (a, b, c, d, endpoint) => !rectangles.some((rect) =>
      rect !== endpoint && overlaps(a, c, rect[along], rect[length]) &&
      overlaps(b, d, rect[across], rect[breadth]));
    const bundles = [];
    for (const direction of [-1, 1]) {
      const start = parent[along] + (direction > 0 ? parent[length] : 0);
      const branches = children.map(({ id, rect }) => ({
        id, rect,
        end: rect[along] + (direction < 0 ? rect[length] : 0),
        center: rect[across] + rect[breadth] / 2,
      })).filter(({ end }) => direction * (end - start) >= 8)
        .sort((a, b) => a.center - b.center);
      if (branches.length < 2 || branches.some(({ center }, index) =>
        index > 0 && center - branches[index - 1].center < 8)) continue;

      const near = Math.min(...branches.map(({ end }) => direction * (end - start)));
      const top = Math.min(parentCenter, branches[0].center);
      const bottom = Math.max(parentCenter, branches.at(-1).center);
      const rail = [0.5, 0.33, 0.67].map((fraction) => start + direction * near * fraction)
        .find((candidate) => clear(start, parentCenter, candidate, parentCenter, parent) &&
          clear(candidate, top, candidate, bottom) && branches.every(({ rect, end, center }) =>
            clear(candidate, center, end, center, rect)));
      if (rail === undefined) continue;

      const edges = branches.map(({ id, end, center }) => {
        const hit = segment(rail, center, end, center);
        const lead = `M${point(start, parentCenter)}`;
        const radius = Math.min(8, Math.abs(rail - start) / 2, Math.abs(end - rail) / 2,
          Math.abs(center - parentCenter) / 2);
        if (!radius) return { id, d: `${lead} L${point(end, center)}`, hit };
        const bend = Math.sign(center - parentCenter) * radius;
        const inset = direction * radius;
        const d = `${lead} L${point(rail - inset, parentCenter)} ` +
          `Q${point(rail, parentCenter)} ${point(rail, parentCenter + bend)} ` +
          `L${point(rail, center - bend)} Q${point(rail, center)} ${point(rail + inset, center)} ` +
          `L${point(end, center)}`;
        return { id, d, hit };
      });
      const d = [segment(start, parentCenter, rail, parentCenter), segment(rail, top, rail, bottom),
        ...edges.map(({ hit }) => hit)].join(" ");
      bundles.push({ d, edges });
    }
    return bundles;
  }

  function compactCardRows(cards) {
    const positions = new Map();
    if (!cards.length) return positions;
    const gutter = 24;
    const ordered = [...cards].sort((a, b) => Math.round(a.y) - Math.round(b.y) || a.x - b.x);
    const left = Math.min(...cards.map((card) => card.x));
    let y = Math.min(...cards.map((card) => card.y));
    let row = Math.round(ordered[0].y);
    let x = left;
    let rowHeight = 0;
    for (const card of ordered) {
      const nextRow = Math.round(card.y);
      if (nextRow !== row) {
        row = nextRow;
        y += rowHeight + gutter;
        x = left;
        rowHeight = 0;
      }
      positions.set(card.id, { x, y, width: card.width, height: card.height });
      x += card.width + gutter;
      rowHeight = Math.max(rowHeight, card.height);
    }
    return positions;
  }

  function layoutBranches(nodes, core, compact = false, { twoSided = true, sectionColumns = false } = {}) {
    const gapX = compact ? 52 : 88;
    const gapY = compact ? 22 : 36;
    const byId = new Map();
    const roots = [];
    for (const node of nodes) {
      const item = { ...node, children: [] };
      // Parents must precede children; stale or cyclic references become roots.
      const parent = node.parentIds.map((id) => byId.get(id)).find(Boolean);
      if (parent) parent.children.push(item);
      else roots.push(item);
      byId.set(node.id, item);
    }
    function sectionGrid(sections) {
      const farOffset = Math.max(...sections.filter((_, index) => index % 2 === 0).map(({ width }) => width)) + gapY;
      const slots = [];
      let nearBottom = -gapY;
      let farBottom = -Infinity;
      for (let index = 0; index < sections.length; index += 2) {
        const near = sections[index];
        const far = sections[index + 1];
        let nearY = nearBottom + gapY;
        if (far) {
          // Place the outer card's connector port in the gap after the inner card.
          const port = Math.max(nearY + near.height + gapY / 2, farBottom + gapY + far.height / 2);
          nearY = port - gapY / 2 - near.height;
          const farY = port - far.height / 2;
          slots.push({ card: far, offset: farOffset, y: farY });
          farBottom = farY + far.height;
        }
        slots.push({ card: near, offset: 0, y: nearY });
        nearBottom = nearY + near.height;
      }
      const top = Math.min(...slots.map(({ y }) => y));
      return { slots, top, height: Math.max(nearBottom, farBottom) - top };
    }

    function groupSections(items) {
      if (!sectionColumns) return items;
      const sectionsByAnswer = new Map();
      for (const item of items) {
        if (!item.sectionOf || item.children.length) continue;
        if (!sectionsByAnswer.has(item.sectionOf)) sectionsByAnswer.set(item.sectionOf, []);
        sectionsByAnswer.get(item.sectionOf).push(item);
      }
      return items.flatMap((item) => {
        const sections = sectionsByAnswer.get(item.sectionOf);
        if (!sections || sections.length < sectionColumnThreshold || item.children.length) return [item];
        return item === sections[0] ? [sectionGrid(sections)] : [];
      });
    }

    function pack(branches) {
      const cards = [];
      let top = 0;
      let bottom = 0;
      for (const [index, branch] of branches.entries()) {
        let offset = index ? bottom + gapY - branch.top : 0;
        // Align the nearby cards first. Deeper cards only add spacing where they share horizontal space.
        for (const rect of branch.cards) {
          for (const previous of cards) {
            if (rect.x < previous.x + previous.width + 8 && rect.x + rect.width + 8 > previous.x) {
              offset = Math.max(offset, previous.y + previous.height + gapY - rect.y);
            }
          }
        }
        for (const rect of branch.cards) cards.push({ ...rect, y: rect.y + offset });
        if (!index) top = branch.top + offset;
        bottom = branch.bottom + offset;
      }
      return { cards, top, bottom };
    }

    function build(node) {
      if (node.slots) {
        const cards = node.slots.map(({ card, offset, y }) =>
          ({ id: card.id, x: offset, y: y - node.top, width: card.width, height: card.height }));
        return { cards, top: 0, bottom: node.height };
      }
      const { id, width, height } = node;
      const children = pack(groupSections(node.children).map(build));
      const center = (children.top + children.bottom) / 2;
      const cards = [{ id, x: 0, y: -height / 2, width, height }, ...children.cards.map((rect) =>
        ({ ...rect, x: rect.x + width + gapX, y: rect.y - center }))];
      return { cards, top: -height / 2, bottom: height / 2 };
    }

    const branches = groupSections(roots).map(build);
    const heightsOf = new Map(branches.map((branch) => [branch,
      Math.max(...branch.cards.map(({ y, height }) => y + height)) - Math.min(...branch.cards.map(({ y }) => y))]));
    const byHeight = twoSided ? [...branches].sort((a, b) => heightsOf.get(b) - heightsOf.get(a)) : branches;
    const sideOf = new Map();
    const heights = [0, 0];
    for (const root of byHeight) {
      const side = twoSided && heights[1] < heights[0] ? 1 : 0;
      sideOf.set(root, side);
      heights[side] += heightsOf.get(root) + gapY;
    }
    const sides = [[], []];
    for (const root of branches) sides[sideOf.get(root)].push(root);
    const result = new Map();
    sides.forEach((items, side) => {
      const { cards, top, bottom } = pack(items);
      const offsetY = core.y + core.height / 2 - (top + bottom) / 2;
      for (const { id, x, y, width, height } of cards) {
        const left = side === 0 ? core.x + core.width + gapX + x : core.x - gapX - x - width;
        result.set(id, { x: left, y: y + offsetY, width, height });
      }
    });
    return result;
  }

  const geometry = { scenePoint, bounds, contains, intersectsShape, isLasso, placeNote, placeNoteGroup,
    routeAcrossCards, orthogonalSegments, routeAroundCards, sharedBranchRoutes, compactCardRows, layoutBranches, sectionColumnThreshold };
  if (typeof window !== 'undefined') window.BoardGeometry = geometry;
  if (typeof module !== 'undefined') module.exports = geometry;
})();
