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

  // Cards a lasso encloses, as ids in input order. Orientation-independent; concave and
  // self-crossing strokes use even-odd containment through contains().
  // Strict: center and the four slightly inset corners are inside (the existing rule).
  // Loose (allowLoose only): the center is inside and a cell-centered sample grid shows at
  // least LOOSE_COVERAGE of the card inside, tolerating rounded corners and a missed edge.
  function cardLassoHits(points, cards, { allowLoose = false } = {}) {
    const LOOSE_COVERAGE = 0.64;
    const GRID = 6;
    if (!Array.isArray(points) || !Array.isArray(cards) || !isLasso(points)) return [];

    const region = bounds(points);
    const hits = [];
    for (const { id, rect } of cards) {
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
      const { x, y, width, height } = rect;
      const overlapX = Math.min(x + width, region.x + region.width) - Math.max(x, region.x);
      const overlapY = Math.min(y + height, region.y + region.height) - Math.max(y, region.y);
      if (overlapX <= 0 || overlapY <= 0) continue;
      // A card the stroke's bounding box cannot mostly cover can never qualify loosely.
      const boxCoverage = overlapX * overlapY / (width * height);
      if (!allowLoose && boxCoverage < 0.5) continue;

      if (!contains({ x: x + width / 2, y: y + height / 2 }, points)) continue;

      const insetX = Math.min(width * 0.1, 16);
      const insetY = Math.min(height * 0.1, 16);
      const strict = [
        { x: x + insetX, y: y + insetY }, { x: x + width - insetX, y: y + insetY },
        { x: x + insetX, y: y + height - insetY }, { x: x + width - insetX, y: y + height - insetY },
      ].every((point) => contains(point, points));
      if (strict) {
        hits.push(id);
        continue;
      }
      if (!allowLoose || boxCoverage < LOOSE_COVERAGE) continue;

      let inside = 0;
      for (let row = 0; row < GRID; row++) {
        for (let column = 0; column < GRID; column++) {
          if (contains({ x: x + (column + 0.5) * width / GRID, y: y + (row + 0.5) * height / GRID }, points)) inside += 1;
        }
      }
      if (inside / (GRID * GRID) >= LOOSE_COVERAGE) hits.push(id);
    }
    return hits;
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
            best = roundedOrthogonalPath(points, [parent, child, ...blockers]);
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

  function roundedOrthogonalPath(points, rectangles) {
    const corners = [];
    const heading = (from, to) => [Math.sign(to[0] - from[0]), Math.sign(to[1] - from[1])];
    for (const point of points) {
      const last = corners.at(-1);
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      if (corners.length > 1) {
        const [inX, inY] = heading(corners.at(-2), last);
        const [outX, outY] = heading(last, point);
        if ((!inX || !inY) && inX === outX && inY === outY) corners.pop();
      }
      corners.push(point);
    }
    if (corners.length < 2) return "";
    const path = [`M${corners[0]}`];
    for (let index = 1; index < corners.length - 1; index++) {
      const point = corners[index];
      const before = corners[index - 1];
      const after = corners[index + 1];
      const [inX, inY] = heading(before, point);
      const [outX, outY] = heading(point, after);
      let curve = null;
      if (Math.abs(inX) + Math.abs(inY) === 1 && Math.abs(outX) + Math.abs(outY) === 1 &&
          inX * outX + inY * outY === 0) {
        const [x, y] = point;
        const maximum = Math.min(18, Math.hypot(x - before[0], y - before[1]) / 2,
          Math.hypot(after[0] - x, after[1] - y) / 2);
        for (let radius = maximum; radius >= 1; radius /= 2) {
          const start = [x - inX * radius, y - inY * radius];
          const end = [x + outX * radius, y + outY * radius];
          // The curve stays inside this corner rectangle, so its entire arc clears the cards.
          if (!clearOrthogonalPath([start, end], rectangles)) continue;
          curve = `L${start} Q${point} ${end}`;
          break;
        }
      }
      path.push(curve ?? `L${point}`);
    }
    path.push(`L${corners.at(-1)}`);
    return path.join(" ");
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
    const point = (a, b) => horizontal ? [a, b] : [b, a];
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
        const d = roundedOrthogonalPath([point(start, parentCenter), point(rail, parentCenter),
          point(rail, center), point(end, center)], rectangles);
        return { id, d, hit };
      });
      const d = edges.map((edge) => edge.d).join(" ");
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

  function staggeredColumns(sections, gapY) {
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

  function layoutBranches(nodes, core, compact = false, { twoSided = true, sectionColumns = false, branchSides } = {}) {
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
        return item === sections[0] ? [staggeredColumns(sections, gapY)] : [];
      });
    }

    function pack(branches) {
      const cards = [];
      let top = 0;
      let bottom = 0;
      for (const [index, branch] of branches.entries()) {
        let offset = index ? bottom + gapY - branch.top : 0;
        // Keep sibling heads in order and find the first offset where their full shapes fit.
        const blocked = [];
        for (const rect of branch.cards) {
          for (const previous of cards) {
            if (rect.x < previous.x + previous.width + 8 && rect.x + rect.width + 8 > previous.x) {
              const end = previous.y + previous.height + gapY - rect.y;
              if (end > offset) blocked.push({ start: previous.y - gapY - rect.y - rect.height, end });
            }
          }
        }
        blocked.sort((a, b) => a.start - b.start);
        for (const { start, end } of blocked) {
          if (start >= offset) break;
          offset = Math.max(offset, end);
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
      const fixedSide = branchSides?.get(root.cards[0]?.id);
      const side = twoSided && (fixedSide === 0 || fixedSide === 1) ? fixedSide :
        twoSided && heights[1] < heights[0] ? 1 : 0;
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

  const layoutAdaptive = (() => {
    const cardGap = 26;
    const parentGap = 52;
    const directions = ["north", "west", "south", "east"];
    const defaultViewport = { width: 1182, height: 755 };

    const right = (rect) => rect.x + rect.width;
    const bottom = (rect) => rect.y + rect.height;

    function bounds(rects) {
      const x = Math.min(...rects.map((rect) => rect.x));
      const y = Math.min(...rects.map((rect) => rect.y));
      return {
        x, y,
        width: Math.max(...rects.map(right)) - x,
        height: Math.max(...rects.map(bottom)) - y,
      };
    }

    function overlaps(a, b, gap) {
      return a.x < right(b) + gap && right(a) + gap > b.x &&
        a.y < bottom(b) + gap && bottom(a) + gap > b.y;
    }

    function translate(rect, x, y) {
      return { ...rect, x: rect.x + x, y: rect.y + y };
    }

    function fit(rect, viewport) {
      return Math.min(viewport.width / rect.width, viewport.height / rect.height);
    }

    function railBounds(children, parent, side) {
      const row = side === "north" || side === "south";
      const parallel = row ? "width" : "height";
      const perpendicular = row ? "height" : "width";
      const length = children.reduce((sum, child) => sum + child.bounds[parallel], 0) +
        cardGap * (children.length - 1);
      const depth = Math.max(...children.map((child) => child.bounds[perpendicular]));
      if (row) {
        const y = side === "north" ? parent.y - parentGap - depth : bottom(parent) + parentGap;
        return { x: -length / 2, y, width: length, height: depth };
      }
      const x = side === "west" ? parent.x - parentGap - depth : right(parent) + parentGap;
      return { x, y: -length / 2, width: depth, height: length };
    }

    function railCards({ children, side, bounds: rail, cards: columns }) {
      if (columns) return columns;
      const row = side === "north" || side === "south";
      let cursor = row ? rail.x : rail.y;
      const cards = [];
      for (const child of children) {
        const block = child.bounds;
        const x = row ? cursor : side === "west" ? right(rail) - block.width : rail.x;
        const y = row ? (side === "north" ? bottom(rail) - block.height : rail.y) : cursor;
        for (const card of child.cards) {
          cards.push({ id: card.id, rect: translate(card.rect, x - block.x, y - block.y) });
        }
        cursor += (row ? block.width : block.height) + cardGap;
      }
      return cards;
    }

    function leafColumns(children, parent, side) {
      if (side === "north" || side === "south" || children.length < sectionColumnThreshold ||
        children.some((child) => child.cards.length !== 1)) return null;
      const leaves = children.map(({ cards: [{ id, rect }] }) => ({ id, ...rect }));
      const { slots, top, height } = staggeredColumns(leaves, cardGap);
      const cards = slots.map(({ card, offset, y }) => {
        const x = side === "west" ? parent.x - parentGap - card.width - offset : right(parent) + parentGap + offset;
        return { id: card.id, rect: { x, y: y - top - height / 2, width: card.width, height: card.height } };
      });
      return { side, cards, bounds: bounds(cards.map(({ rect }) => rect)) };
    }

    function planCandidates(parent, children, viewport) {
      // Try every boundary for ordinary branches. Sample large ones to bound the split search.
      const intervals = Math.min(children.length, 18);
      const cuts = [0];
      for (let index = 1; index <= intervals; index++) {
        cuts.push(Math.round(index * children.length / intervals));
      }
      const allRails = directions.map((side) => cuts.map((from, start) =>
        cuts.map((to, end) => {
          if (end <= start) return null;
          const band = children.slice(from, to);
          return { side, children: band, bounds: railBounds(band, parent, side), columns: leafColumns(band, parent, side) };
        })));

      const last = cuts.length - 1;
      const plans = [];
      function consider(rails) {
        if (rails.some((rail, index) => rails.slice(index + 1)
          .some((other) => overlaps(rail.bounds, other.bounds, cardGap)))) return;
        const extent = bounds([parent, ...rails.map((rail) => rail.bounds)]);
        plans.push({ rails, bounds: extent, fit: fit(extent, viewport) });
      }
      for (let a = 0; a <= last; a++) {
        for (let b = a; b <= last; b++) {
          for (let c = b; c <= last; c++) {
            const rails = [allRails[0][0][a], allRails[1][a][b], allRails[2][b][c],
              allRails[3][c][last]].filter(Boolean);
            consider(rails);
            for (const [index, rail] of rails.entries()) {
              if (rail.columns) consider(rails.with(index, rail.columns));
            }
          }
        }
      }
      return plans.sort((a, b) => b.fit - a.fit ||
        a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
    }

    function materialize(id, rect, plan) {
      return { bounds: plan.bounds, cards: [{ id, rect }, ...plan.rails.flatMap(railCards)] };
    }

    function closestFree(block, x, y, occupied) {
      const queue = [];
      const seen = new Set();
      function enqueue(left, top) {
        const key = `${left},${top}`;
        if (seen.has(key)) return;
        seen.add(key);
        queue.push({ x: left, y: top, distance: (left - x) ** 2 + (top - y) ** 2 });
      }
      enqueue(x, y);
      for (let attempt = 0; queue.length && attempt < 128; attempt++) {
        queue.sort((a, b) => a.distance - b.distance);
        const offset = queue.shift();
        let collision;
        for (const { rect } of block.cards) {
          const placed = translate(rect, offset.x, offset.y);
          const obstacle = occupied.find((other) => overlaps(placed, other, cardGap));
          if (obstacle) {
            collision = { rect, obstacle };
            break;
          }
        }
        if (!collision) return offset;
        const { rect, obstacle } = collision;
        enqueue(obstacle.x - cardGap - right(rect), offset.y);
        enqueue(right(obstacle) + cardGap - rect.x, offset.y);
        enqueue(offset.x, obstacle.y - cardGap - bottom(rect));
        enqueue(offset.x, bottom(obstacle) + cardGap - rect.y);
      }
      // The canvas is unbounded. Always leave a collision-free placement when the nearby search fills.
      return { x: Math.max(...occupied.map(right)) + cardGap - block.bounds.x, y };
    }

    function layout(nodes, rects, roots, { fixedIds = [], viewport = defaultViewport } = {}) {
      const measuredViewport = {
        width: viewport.width > 0 ? viewport.width : defaultViewport.width,
        height: viewport.height > 0 ? viewport.height : defaultViewport.height,
      };
      const byId = new Map(nodes.filter(({ id }) => rects.has(id)).map((node) => [node.id, node]));
      const childrenById = new Map();
      for (const { id, parentId } of byId.values()) {
        if (parentId === id || !byId.has(parentId)) continue;
        if (!childrenById.has(parentId)) childrenById.set(parentId, []);
        childrenById.get(parentId).push(id);
      }
      const scope = new Set(roots.filter((id) => byId.has(id)));
      for (const id of scope) {
        for (const child of childrenById.get(id) || []) scope.add(child);
      }
      const fixed = new Set(fixedIds);
      const movable = new Set([...scope].filter((id) => !fixed.has(id)));
      const occupied = [...rects].filter(([id]) => !movable.has(id)).map(([, rect]) => rect);
      const result = new Map();
      const visited = new Set();

      function build(id) {
        visited.add(id);
        const { width, height } = rects.get(id);
        const rect = { x: -width / 2, y: -height / 2, width, height };
        const children = (childrenById.get(id) || []).filter((child) => movable.has(child))
          .flatMap((child) => {
            if (visited.has(child)) return [];
            const subtree = build(child);
            const plan = subtree.plans[0];
            return [{
              ...materialize(child, subtree.rect, plan), chainLength: subtree.chainLength, heading: plan.rails[0]?.side,
            }];
          });
        const chainLength = children.length === 0 ? 1 :
          children.length === 1 && children[0].chainLength ? children[0].chainLength + 1 : 0;
        const plans = planCandidates(rect, children, measuredViewport);
        if (chainLength >= 3 && chainLength <= 6) {
          // Continue the same short chain in one direction, while retaining alternatives around fixed cards.
          const continuing = plans.findIndex((plan) => plan.rails[0]?.side === children[0].heading);
          if (continuing > 0) plans.unshift(...plans.splice(continuing, 1));
        }
        return { rect, children, plans, chainLength };
      }

      function store(block, x, y) {
        for (const { id, rect } of block.cards) {
          if (!movable.has(id)) continue;
          const placed = translate(rect, x, y);
          result.set(id, placed);
          occupied.push(placed);
        }
      }

      function place(id) {
        const original = rects.get(id);
        const x = original.x + original.width / 2;
        const y = original.y + original.height / 2;
        const { rect, children, plans } = build(id);
        for (const plan of plans) {
          const block = materialize(id, rect, plan);
          if (block.cards.every((card) => !movable.has(card.id) ||
            !occupied.some((other) => overlaps(translate(card.rect, x, y), other, cardGap)))) {
            store(block, x, y);
            return;
          }
        }
        if (movable.has(id)) {
          const block = materialize(id, rect, plans[0]);
          const offset = closestFree(block, x, y, occupied);
          store(block, offset.x, offset.y);
          return;
        }

        // A fixed card cannot move with its children. Fit each branch around it and the obstacles.
        for (const child of children) {
          const placements = directions.map((side) => {
            const rail = railBounds([child], rect, side);
            const offset = closestFree(child, x + rail.x - child.bounds.x, y + rail.y - child.bounds.y, occupied);
            const distance = (offset.x - x) ** 2 + (offset.y - y) ** 2;
            return { ...offset, distance };
          });
          const best = placements.reduce((first, next) => next.distance < first.distance ? next : first);
          store(child, best.x, best.y);
        }
      }

      for (const id of scope) {
        if (fixed.has(id) || !scope.has(byId.get(id).parentId)) place(id);
      }
      // A stale cyclic parent link can leave a scoped card without a component root.
      for (const id of movable) {
        if (!result.has(id)) place(id);
      }
      return result;
    }
    return layout;
  })();

  function stabilizeFoldLayout(placements, previous, parents, fixedIds, gap = 20) {
    const placed = new Map();
    for (const [id, rect] of placements) {
      const before = previous.get(id);
      if (before) placed.set(id, { ...rect, x: before.x, y: before.y });
      else if (fixedIds.has(id)) placed.set(id, rect);
    }

    const visiting = new Set();
    function place(id) {
      const proposed = placements.get(id);
      if (!proposed || placed.has(id) || visiting.has(id)) return;
      visiting.add(id);
      const parent = parents.get(id);
      place(parent);
      const origin = placements.get(parent);
      const anchor = placed.get(parent);
      const rect = { ...proposed };
      if (origin && anchor) {
        rect.x += anchor.x - origin.x;
        rect.y += anchor.y - origin.y;
      }

      // Keep the proposed column. In that column each obstacle blocks one interval
      // of top coordinates, so both ends of each interval are possible free slots.
      const blocked = [...placed.values()]
        .filter(other => rect.x < other.x + other.width + gap && other.x < rect.x + rect.width + gap)
        .map(other => [other.y - rect.height - gap, other.y + other.height + gap])
        .sort((first, second) => first[0] - second[0]);
      const bands = [];
      for (const [top, bottom] of blocked) {
        const last = bands.at(-1);
        if (last && top < last[1]) last[1] = Math.max(last[1], bottom);
        else bands.push([top, bottom]);
      }
      const band = bands.find(([top, bottom]) => top < rect.y && rect.y < bottom);
      if (band) {
        const [top, bottom] = band;
        rect.y = rect.y - top <= bottom - rect.y ? top : bottom;
      }
      placed.set(id, rect);
      visiting.delete(id);
    }
    for (const id of placements.keys()) place(id);
    for (const [id, rect] of placed) Object.assign(placements.get(id), rect);
  }

  const geometry = { scenePoint, bounds, contains, intersectsShape, isLasso, cardLassoHits, placeNote, placeNoteGroup,
    routeAcrossCards, roundedOrthogonalPath, orthogonalSegments, routeAroundCards, sharedBranchRoutes, compactCardRows, layoutBranches,
    sectionColumnThreshold, layoutAdaptive, stabilizeFoldLayout };
  if (typeof window !== 'undefined') window.BoardGeometry = geometry;
  if (typeof module !== 'undefined') module.exports = geometry;
})();
