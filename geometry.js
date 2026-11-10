(() => {
  const EPSILON = 1e-7;

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

  function placeNote(anchorRect, occupiedRects, boardRect, noteSize) {
    const gap = 14;
    const width = Math.min(noteSize.width, boardRect.width);
    const height = Math.min(noteSize.height, boardRect.height);
    const right = boardRect.x + boardRect.width - width;
    const bottom = boardRect.y + boardRect.height - height;
    const clampX = (x) => Math.max(boardRect.x, Math.min(x, right));
    const clampY = (y) => Math.max(boardRect.y, Math.min(y, bottom));
    const anchorRight = anchorRect.x + anchorRect.width;
    const preferredX = anchorRight + gap;
    const preferredY = anchorRect.y;
    const gutter = 7;
    const blockers = [anchorRect, ...occupiedRects].map((rect) => ({
      x: rect.x - gutter,
      y: rect.y - gutter,
      width: rect.width + 2 * gutter,
      height: rect.height + 2 * gutter,
    }));

    // An open spot can start beside a blocker or against a board edge.
    const candidateX = new Set([clampX(preferredX), boardRect.x, right]);
    const candidateY = new Set([clampY(preferredY), boardRect.y, bottom]);
    for (const rect of blockers) {
      candidateX.add(clampX(rect.x - width));
      candidateX.add(clampX(rect.x + rect.width));
      candidateY.add(clampY(rect.y - height));
      candidateY.add(clampY(rect.y + rect.height));
    }

    let best = { x: clampX(preferredX), y: clampY(preferredY) };
    let bestOverlap = Infinity;
    let bestSide = Infinity;
    let bestDistance = Infinity;
    for (const x of candidateX) {
      for (const y of candidateY) {
        let overlap = 0;
        for (const rect of blockers) {
          const overlapX = Math.max(0, Math.min(x + width, rect.x + rect.width) - Math.max(x, rect.x));
          const overlapY = Math.max(0, Math.min(y + height, rect.y + rect.height) - Math.max(y, rect.y));
          overlap += overlapX * overlapY;
        }
        const side = x >= anchorRight ? 0 : 1;
        const distance = (x - preferredX) ** 2 + (y - preferredY) ** 2;
        if (overlap < bestOverlap || (overlap === bestOverlap &&
            (side < bestSide || (side === bestSide && distance < bestDistance)))) {
          best = { x, y };
          bestOverlap = overlap;
          bestSide = side;
          bestDistance = distance;
        }
      }
    }
    return best;
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

  // A two-sided tidy forest: reserve each subtree's full height before placing it.
  function layoutBranches(nodes, core, compact = false) {
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
    function measure(node) {
      const childrenHeight = node.children.reduce((sum, child) => sum + measure(child), 0) +
        Math.max(0, node.children.length - 1) * gapY;
      node.span = Math.max(node.height, childrenHeight);
      return node.span;
    }
    const sides = [[], []];
    const heights = [0, 0];
    for (const root of roots) {
      measure(root);
      const side = heights[0] <= heights[1] ? 0 : 1;
      sides[side].push(root);
      heights[side] += root.span + gapY;
    }
    const result = new Map();
    function place(node, edge, top, direction) {
      const x = direction > 0 ? edge + gapX : edge - gapX - node.width;
      const y = top + (node.span - node.height) / 2;
      result.set(node.id, { x, y, width: node.width, height: node.height });
      const total = node.children.reduce((sum, child) => sum + child.span, 0) +
        Math.max(0, node.children.length - 1) * gapY;
      let childTop = top + (node.span - total) / 2;
      for (const child of node.children) {
        place(child, direction > 0 ? x + node.width : x, childTop, direction);
        childTop += child.span + gapY;
      }
    }
    sides.forEach((items, side) => {
      let top = core.y + core.height / 2 - Math.max(0, heights[side] - gapY) / 2;
      for (const item of items) {
        place(item, side === 0 ? core.x + core.width : core.x, top, side === 0 ? 1 : -1);
        top += item.span + gapY;
      }
    });
    return result;
  }

  const geometry = { scenePoint, bounds, contains, intersectsShape, isLasso, placeNote,
    routeAcrossCards, compactCardRows, layoutBranches };
  if (typeof window !== 'undefined') window.BoardGeometry = geometry;
  if (typeof module !== 'undefined') module.exports = geometry;
})();
