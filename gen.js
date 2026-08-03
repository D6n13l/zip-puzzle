// Zip-style puzzle generator: Hamiltonian path + numbered checkpoints + walls
// enforcing (best-effort) uniqueness via bounded backtracking solver.
// Browser ES module version (ported 1:1 from the tested node prototype).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStringToSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0);
}

const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];

function idx(r, c, n) { return r * n + c; }
function rc(i, n) { return [Math.floor(i / n), i % n]; }

export function neighbors(i, n) {
  const [r, c] = rc(i, n);
  const out = [];
  for (const [dr, dc] of DIRS) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < n && nc >= 0 && nc < n) out.push(idx(nr, nc, n));
  }
  return out;
}

export function edgeKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }

function generateHamiltonianPath(n, rng, nodeBudget = 400000, warnsdorffProb = 0.75) {
  const total = n * n;
  const start = Math.floor(rng() * total);
  const visited = new Uint8Array(total);
  const path = [start];
  visited[start] = 1;
  let nodes = 0;

  function freeDegree(cell) {
    let d = 0;
    for (const nb of neighbors(cell, n)) if (!visited[nb]) d++;
    return d;
  }

  function dfs(cell) {
    nodes++;
    if (nodes > nodeBudget) return false;
    if (path.length === total) return true;
    let opts = neighbors(cell, n).filter((nb) => !visited[nb]);
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [opts[i], opts[j]] = [opts[j], opts[i]];
    }
    // Applying the Warnsdorff heuristic (prefer lower-freedom neighbors)
    // most — but not all — of the time keeps path-finding tractable on
    // larger grids while still letting the path wander/backtrack instead
    // of always taking the locally most efficient route (a fully "smart"
    // path means the true route between any two checkpoints is already
    // the shortest possible one — trivially connect-the-dots).
    if (rng() < warnsdorffProb) opts.sort((a, b) => freeDegree(a) - freeDegree(b));
    for (const nb of opts) {
      visited[nb] = 1;
      path.push(nb);
      if (dfs(nb)) return true;
      path.pop();
      visited[nb] = 0;
    }
    return false;
  }

  const ok = dfs(start);
  return ok ? path.slice() : null;
}

function cellRC(idx, n) { return [Math.floor(idx / n), idx % n]; }
function manhattan(a, b, n) {
  const [ar, ac] = cellRC(a, n), [br, bc] = cellRC(b, n);
  return Math.abs(ar - br) + Math.abs(ac - bc);
}

// Splits the path into equal chunks and measures each chunk's spatial
// bounding-box "size" (how much of the grid it spans). A path that fills
// one region before moving to the next will have a badly uneven profile
// (e.g. a wide-open first half, then a cramped, confined tail) — that's
// exactly what makes numbered checkpoints bunch up near the end. We reject
// paths whose spread is too uneven and try a different one instead.
function pathSpreadRatio(path, n, parts = 4) {
  const total = path.length;
  const partSize = Math.floor(total / parts);
  const spans = [];
  for (let p = 0; p < parts; p++) {
    const start = p * partSize;
    const end = p === parts - 1 ? total : start + partSize;
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (let i = start; i < end; i++) {
      const [r, c] = cellRC(path[i], n);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
    }
    spans.push((maxR - minR) + (maxC - minC));
  }
  const maxSpan = Math.max(...spans, 1);
  const minSpan = Math.max(Math.min(...spans), 1);
  return maxSpan / minSpan;
}

function generatePathWithRetries(n, rng, tries = 25) {
  let fallback = null;
  let fallbackRatio = Infinity;
  for (let t = 0; t < tries; t++) {
    const p = generateHamiltonianPath(n, rng);
    if (!p) continue;
    const ratio = pathSpreadRatio(p, n);
    if (ratio < fallbackRatio) { fallback = p; fallbackRatio = ratio; }
    if (ratio <= 2.2) return p; // evenly-spread-enough path found
  }
  return fallback; // best (most even) path seen, even if none hit the bar
}

function placeDots(path, k) {
  const total = path.length;
  const positions = [0];
  for (let i = 1; i < k - 1; i++) {
    positions.push(Math.round((i * (total - 1)) / (k - 1)));
  }
  positions.push(total - 1);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] <= positions[i - 1]) positions[i] = positions[i - 1] + 1;
  }
  const dotsByCell = {};
  positions.forEach((pos, i) => {
    dotsByCell[path[pos]] = i + 1;
  });
  return dotsByCell;
}

export function countSolutions(n, dotsByCell, walls, cap = 2, nodeBudget = 250000) {
  const total = n * n;
  const cellsWithDots = Object.keys(dotsByCell).map(Number);
  const numDots = cellsWithDots.length;
  const startCell = cellsWithDots.find((c) => dotsByCell[c] === 1);
  const endCell = cellsWithDots.find((c) => dotsByCell[c] === numDots);

  const visited = new Uint8Array(total);
  let found = 0;
  let nodes = 0;
  let budgetExceeded = false;

  // Connectivity prune: after tentatively stepping onto `fromCell`, check that
  // every still-unvisited cell is reachable from there (through non-wall
  // edges). If any unvisited cell is cut off, this branch can never complete
  // a full grid-filling path, so we can abandon it immediately instead of
  // exploring a doomed subtree. This is what makes sparser (harder) puzzles
  // tractable to verify.
  const stack = new Int32Array(total);
  const seen = new Uint8Array(total);
  function reachableUnvisitedCount(fromCell) {
    seen.fill(0);
    let sp = 0;
    stack[sp++] = fromCell;
    seen[fromCell] = 1;
    let cnt = 0;
    while (sp > 0) {
      const cur = stack[--sp];
      for (const nb of neighbors(cur, n)) {
        if (visited[nb] || seen[nb]) continue;
        if (walls.has(edgeKey(cur, nb))) continue;
        seen[nb] = 1;
        cnt++;
        stack[sp++] = nb;
      }
    }
    return cnt;
  }

  function dfs(cell, count, nextDot) {
    if (found >= cap || budgetExceeded) return;
    nodes++;
    if (nodes > nodeBudget) { budgetExceeded = true; return; }
    if (count === total) {
      if (cell === endCell && nextDot === numDots + 1) found++;
      return;
    }
    for (const nb of neighbors(cell, n)) {
      if (visited[nb]) continue;
      if (walls.has(edgeKey(cell, nb))) continue;
      const label = dotsByCell[nb];
      let newNextDot = nextDot;
      if (label !== undefined) {
        if (label !== nextDot) continue;
        newNextDot = nextDot + 1;
      }
      visited[nb] = 1;
      const remaining = total - (count + 1);
      if (remaining === 0 || reachableUnvisitedCount(nb) === remaining) {
        dfs(nb, count + 1, newNextDot);
      }
      visited[nb] = 0;
      if (found >= cap || budgetExceeded) return;
    }
  }

  visited[startCell] = 1;
  dfs(startCell, 1, 2);
  return { count: found, budgetExceeded };
}

function cellDegree(cell, n) { return neighbors(cell, n).length; }

function generateWalls(n, path, dotsByCell, rng, opts = {}) {
  // Phase 1: add walls (random order) until the solution is unique. No
  // artificial cap here — retries at a higher level handle the rare case
  // where this doesn't converge within the node budget.
  const nodeBudget = opts.nodeBudget ?? 250000;

  const pathEdges = new Set();
  for (let i = 0; i < path.length - 1; i++) {
    pathEdges.add(edgeKey(path[i], path[i + 1]));
  }

  const candidates = [];
  for (let cell = 0; cell < n * n; cell++) {
    for (const nb of neighbors(cell, n)) {
      if (nb <= cell) continue;
      const key = edgeKey(cell, nb);
      if (!pathEdges.has(key)) candidates.push(key);
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const walls = new Set();
  let { count } = countSolutions(n, dotsByCell, walls, 2, nodeBudget);
  let ci = 0;
  let budgetExceeded = false;
  while (count !== 1 && ci < candidates.length) {
    walls.add(candidates[ci]);
    ci++;
    const res = countSolutions(n, dotsByCell, walls, 2, nodeBudget);
    count = res.count;
    budgetExceeded = res.budgetExceeded;
    if (count === 0) {
      walls.delete(candidates[ci - 1]);
      count = 2;
    }
  }

  // Phase 2: shrink toward a near-minimal wall set. A wall only ever removes
  // *wrong* routes (it's never on the true path), so fewer walls means a more
  // open grid with more genuinely tempting wrong turns — that's what makes a
  // puzzle hard, matching how the original game plays: harder boards lean on
  // an almost-bare grid, easier ones lean on walls as guardrails. We try
  // removing each wall (in random order) and keep it removed whenever the
  // solution stays unique without it.
  if (count === 1) {
    const wallList = Array.from(walls);
    for (let i = wallList.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [wallList[i], wallList[j]] = [wallList[j], wallList[i]];
    }
    for (const w of wallList) {
      walls.delete(w);
      const res = countSolutions(n, dotsByCell, walls, 2, nodeBudget);
      if (res.count !== 1) {
        walls.add(w); // still needed — keep it
      }
    }
  }

  // Phase 2.5: block the tempting direct shortcut between each pair of
  // consecutive numbers. Even with a minimal wall set, an open grid often
  // still lets you walk almost straight from one number to the next — this
  // specifically closes that off wherever the true route has to be much
  // longer than the direct one, forcing an actual detour instead of "just
  // connect the dots".
  if (count === 1) {
    const dotCells = Object.keys(dotsByCell).map(Number);
    const numDots = dotCells.length;
    const dotByNumber = new Array(numDots + 1);
    dotCells.forEach((c) => { dotByNumber[dotsByCell[c]] = c; });

    function bfsPath(start, end) {
      const total = n * n;
      const prev = new Int32Array(total).fill(-1);
      const seen = new Uint8Array(total);
      const queue = [start];
      seen[start] = 1;
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        if (cur === end) break;
        for (const nb of neighbors(cur, n)) {
          if (seen[nb] || walls.has(edgeKey(cur, nb))) continue;
          seen[nb] = 1; prev[nb] = cur; queue.push(nb);
        }
      }
      if (!seen[end]) return null;
      const route = [end];
      let c = end;
      while (c !== start) { c = prev[c]; route.push(c); }
      route.reverse();
      return route;
    }

    // Segment lengths along the true path, by number.
    const dotIndexInPath = new Map();
    path.forEach((cell, idx) => { if (dotsByCell[cell] !== undefined) dotIndexInPath.set(dotsByCell[cell], idx); });

    for (let num = 1; num < numDots; num++) {
      const a = dotByNumber[num], b = dotByNumber[num + 1];
      const trueSegLen = dotIndexInPath.get(num + 1) - dotIndexInPath.get(num);
      let attempts = 0;
      while (attempts < 3) {
        const shortest = bfsPath(a, b);
        if (!shortest || shortest.length - 1 >= trueSegLen) break; // no exploitable shortcut left
        // Find an edge on this shortcut that isn't part of the true solution, closest to `a`.
        let blocked = false;
        for (let i = 0; i < shortest.length - 1; i++) {
          const key = edgeKey(shortest[i], shortest[i + 1]);
          if (pathEdges.has(key) || walls.has(key)) continue;
          walls.add(key);
          const res = countSolutions(n, dotsByCell, walls, 2, nodeBudget);
          if (res.count !== 1) { walls.delete(key); continue; } // safety net, shouldn't trigger
          blocked = true;
          break;
        }
        if (!blocked) break;
        attempts++;
      }
    }
  }

  // Phase 3: difficulty-driven *guide* walls (only for easier levels — pass
  // extraWallBudget:0 for hard). These are added back on top of the minimal
  // set, targeted at "branchy" cells (many grid neighbors) where a guardrail
  // is most helpful, making the level friendlier rather than harder.
  const extraWallBudget = opts.extraWallBudget ?? 0;
  if (extraWallBudget > 0 && count === 1) {
    const remaining = candidates.filter((key) => !walls.has(key));
    const scored = remaining.map((key) => {
      const [a, b] = key.split('_').map(Number);
      return { key, score: cellDegree(a, n) + cellDegree(b, n) + rng() * 0.5 };
    });
    scored.sort((x, y) => y.score - x.score);
    for (let i = 0; i < scored.length && i < extraWallBudget; i++) {
      walls.add(scored[i].key);
    }
  }

  return { walls, unique: count === 1, budgetExceeded };
}

// Measures how "obvious" a puzzle is: starting from dot 1, keep taking the
// next cell whenever there's exactly one legal option (respecting walls,
// visited cells, and dot order). This is pure mechanical forcing — no
// lookahead or guessing required. The run length before the first real
// decision point (0 or 2+ options) is how far a human can get without
// thinking at all. Lower is harder; a puzzle that's 100% forced start-to-
// finish takes zero real thought regardless of grid size or wall count.
export function forcedRunLength(n, dotsByCell, walls) {
  const total = n * n;
  const cellsWithDots = Object.keys(dotsByCell).map(Number);
  const startCell = cellsWithDots.find((c) => dotsByCell[c] === 1);
  const visited = new Uint8Array(total);
  visited[startCell] = 1;
  let current = startCell;
  let nextDot = 2;
  let steps = 1;
  for (;;) {
    const options = [];
    for (const nb of neighbors(current, n)) {
      if (visited[nb]) continue;
      if (walls.has(edgeKey(current, nb))) continue;
      const label = dotsByCell[nb];
      if (label !== undefined && label !== nextDot) continue;
      options.push(nb);
    }
    if (options.length !== 1) break; // stuck, or a real choice — stop counting
    const next = options[0];
    visited[next] = 1;
    if (dotsByCell[next] === nextDot) nextDot++;
    current = next;
    steps++;
    if (steps === total) break; // fully solved by forcing alone
  }
  return steps;
}

// Counts how many times, while walking the TRUE solution path, there was
// more than one legal next move available (respecting walls/visited/dot
// order) — i.e. a real decision point where a wrong choice could paint you
// into a corner. More of these means more places you can build yourself a
// dead end, which is exactly what makes a puzzle risky/hard rather than a
// puzzle that's merely large.
function countBranchPoints(n, path, dotsByCell, walls) {
  const total = n * n;
  const visited = new Uint8Array(total);
  const cellsWithDots = Object.keys(dotsByCell).map(Number);
  const numDots = cellsWithDots.length;
  let nextDot = 2;
  let branchPoints = 0;
  for (let i = 0; i < path.length; i++) {
    const cell = path[i];
    visited[cell] = 1;
    if (dotsByCell[cell] !== undefined) nextDot = dotsByCell[cell] + 1;
    if (i === path.length - 1) break;
    let count = 0;
    for (const nb of neighbors(cell, n)) {
      if (visited[nb]) continue;
      if (walls.has(edgeKey(cell, nb))) continue;
      const label = dotsByCell[nb];
      if (label !== undefined && label !== nextDot) continue;
      count++;
    }
    if (count > 1) branchPoints++;
  }
  return branchPoints;
}

function generatePuzzleAttempt(n, numDots, seed, opts = {}) {
  const rng = mulberry32(seed);
  const path = generatePathWithRetries(n, rng, opts.pathTries ?? 25);
  if (!path) return null;
  const dotsByCell = placeDots(path, numDots);
  const { walls, unique, budgetExceeded } = generateWalls(n, path, dotsByCell, rng, opts);
  return { n, seed, path, dots: dotsByCell, walls: Array.from(walls), unique, budgetExceeded };
}

function sleep0() { return new Promise((resolve) => setTimeout(resolve, 0)); }

export async function generatePuzzle(n, numDots, seed, opts = {}) {
  const maxRetries = opts.maxRetries ?? 12;
  const maxForcedRatio = opts.maxForcedRatio ?? 1; // 1 = no human-difficulty gate
  const candidatesToCompare = opts.candidatesToCompare ?? 1; // >1 picks the trickiest of several unique finds
  let best = null;
  let bestUniqueButTooEasy = null;
  let bestTricky = null; // { result, branchPoints }
  let uniqueFoundCount = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const trySeed = (seed + attempt * 104729) >>> 0;
    const result = generatePuzzleAttempt(n, numDots, trySeed, opts);
    if (!result) { await sleep0(); continue; }
    if (result.unique) {
      const walls = new Set(result.walls);
      const forced = forcedRunLength(n, result.dots, walls);
      const ratio = forced / (n * n);
      if (ratio <= maxForcedRatio) {
        uniqueFoundCount++;
        const branchPoints = countBranchPoints(n, result.path, result.dots, walls);
        if (!bestTricky || branchPoints > bestTricky.branchPoints) {
          bestTricky = { result, branchPoints };
        }
        if (uniqueFoundCount >= candidatesToCompare) return bestTricky.result; // enough candidates compared
      } else if (!bestUniqueButTooEasy || ratio < bestUniqueButTooEasy.ratio) {
        bestUniqueButTooEasy = { result, ratio };
      }
    } else if (!best || result.walls.length > best.walls.length) {
      best = result;
    }
    await sleep0(); // let the browser repaint (loading spinner) between attempts
  }
  if (bestTricky) return bestTricky.result; // fewer unique finds than requested, but use the best we got
  if (bestUniqueButTooEasy) return bestUniqueButTooEasy.result;
  return best;
}
