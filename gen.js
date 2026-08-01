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
      dfs(nb, count + 1, newNextDot);
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

  // Phase 2: difficulty-driven extra barriers. Adding more walls on edges
  // that were never part of the true solution can only ever remove
  // alternative routes, never the real one — so uniqueness is preserved by
  // construction. We deliberately target edges near "branchy" cells (cells
  // with many grid neighbors) since that's where a player has to actively
  // rule out tempting wrong turns, which is what should scale with
  // difficulty rather than raw grid size alone.
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

function generatePuzzleAttempt(n, numDots, seed, opts = {}) {
  const rng = mulberry32(seed);
  const path = generatePathWithRetries(n, rng, opts.pathTries ?? 25);
  if (!path) return null;
  const dotsByCell = placeDots(path, numDots);
  const { walls, unique, budgetExceeded } = generateWalls(n, path, dotsByCell, rng, opts);
  return { n, seed, path, dots: dotsByCell, walls: Array.from(walls), unique, budgetExceeded };
}

export function generatePuzzle(n, numDots, seed, opts = {}) {
  const maxRetries = opts.maxRetries ?? 12;
  let best = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const trySeed = (seed + attempt * 104729) >>> 0;
    const result = generatePuzzleAttempt(n, numDots, trySeed, opts);
    if (!result) continue;
    if (result.unique) return result;
    if (!best || result.walls.length > best.walls.length) best = result;
  }
  return best;
}
