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

function generateHamiltonianPath(n, rng, nodeBudget = 400000) {
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
    opts.sort((a, b) => freeDegree(a) - freeDegree(b));
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

function generatePathWithRetries(n, rng, tries = 25) {
  for (let t = 0; t < tries; t++) {
    const p = generateHamiltonianPath(n, rng);
    if (p) return p;
  }
  return null;
}

function cellRC(idx, n) { return [Math.floor(idx / n), idx % n]; }
function manhattan(a, b, n) {
  const [ar, ac] = cellRC(a, n), [br, bc] = cellRC(b, n);
  return Math.abs(ar - br) + Math.abs(ac - bc);
}

// Places k numbered checkpoints along the solution path. Rather than just
// spacing them evenly by path-index, this deliberately favors checkpoints
// that are geometrically CLOSE to the previous one but require a long,
// winding path to actually reach (high path-distance / low straight-line
// distance) — that's what forces a player to realize "I can't just walk
// toward the next number", instead of the puzzle collapsing into an
// obvious 1-to-2-to-3 straight line.
function placeDots(path, k, n) {
  const total = path.length;
  if (k < 2) k = 2;
  const avgSeg = (total - 1) / (k - 1);
  const window = Math.max(2, Math.floor(avgSeg * 0.7));

  function segScore(j, i) {
    const gap = i - j;
    const dist = manhattan(path[j], path[i], n);
    return gap / (dist + 1); // big index-gap + small spatial distance = deceptive
  }

  const positions = [0];
  for (let m = 1; m < k - 1; m++) {
    const base = Math.round(m * avgSeg);
    const prev = positions[positions.length - 1];
    const minIdx = Math.max(prev + 1, base - window);
    const maxIdx = Math.min(total - 2 - (k - 2 - m), base + window);
    let bestIdx = Math.max(minIdx, Math.min(base, Math.max(minIdx, maxIdx)));
    let bestScore = -Infinity;
    for (let cand = minIdx; cand <= maxIdx; cand++) {
      const score = segScore(prev, cand);
      if (score > bestScore) { bestScore = score; bestIdx = cand; }
    }
    positions.push(bestIdx);
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

function generatePuzzleAttempt(n, numDots, seed, opts = {}) {
  const rng = mulberry32(seed);
  const path = generatePathWithRetries(n, rng, opts.pathTries ?? 25);
  if (!path) return null;
  const dotsByCell = placeDots(path, numDots, n);
  const { walls, unique, budgetExceeded } = generateWalls(n, path, dotsByCell, rng, opts);
  return { n, seed, path, dots: dotsByCell, walls: Array.from(walls), unique, budgetExceeded };
}

function sleep0() { return new Promise((resolve) => setTimeout(resolve, 0)); }

export async function generatePuzzle(n, numDots, seed, opts = {}) {
  const maxRetries = opts.maxRetries ?? 12;
  const maxForcedRatio = opts.maxForcedRatio ?? 1; // 1 = no human-difficulty gate
  let best = null;
  let bestUniqueButTooEasy = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const trySeed = (seed + attempt * 104729) >>> 0;
    const result = generatePuzzleAttempt(n, numDots, trySeed, opts);
    if (!result) { await sleep0(); continue; }
    if (result.unique) {
      const walls = new Set(result.walls);
      const forced = forcedRunLength(n, result.dots, walls);
      const ratio = forced / (n * n);
      if (ratio <= maxForcedRatio) return result; // meets the difficulty bar — done
      // Keep the least-trivial unique candidate seen so far as a fallback
      // in case nothing meets the bar within the retry budget.
      if (!bestUniqueButTooEasy || ratio < bestUniqueButTooEasy.ratio) {
        bestUniqueButTooEasy = { result, ratio };
      }
    } else if (!best || result.walls.length > best.walls.length) {
      best = result;
    }
    await sleep0(); // let the browser repaint (loading spinner) between attempts
  }
  if (bestUniqueButTooEasy) return bestUniqueButTooEasy.result;
  return best;
}
