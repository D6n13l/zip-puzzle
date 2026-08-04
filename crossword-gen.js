// Crossword generator: greedily places words from a shuffled word bank onto
// a sparse grid, connecting them at shared letters, then compiles the final
// numbered grid + across/down clue lists.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cellKey(r, c) { return r + ',' + c; }

// Checks whether `word` can be placed at (row,col) going in `dir` ('H'|'V')
// against the current sparse letter map, and returns a placement descriptor
// with a crossing-count score, or null if invalid.
function tryPlacement(word, row, col, dir, letters, startKeys) {
  let crossings = 0;
  const dr = dir === 'V' ? 1 : 0;
  const dc = dir === 'H' ? 1 : 0;

  // A different word must never start at the exact same cell+direction as
  // an already-placed word — otherwise two words sharing a prefix (e.g.
  // "ATHEN" and "ATHENE") can silently overlay each other, since every
  // individual letter check below would still pass (the shared prefix
  // matches letter-for-letter, and the extra tail lands on empty cells).
  if (startKeys.has(row + ',' + col + ',' + dir)) return null;

  // Cell immediately before the start and after the end must be empty —
  // otherwise this word would run into another word and merge unintentionally.
  const beforeKey = cellKey(row - dr, col - dc);
  const afterKey = cellKey(row + dr * word.length, col + dc * word.length);
  if (letters.has(beforeKey)) return null;
  if (letters.has(afterKey)) return null;

  for (let i = 0; i < word.length; i++) {
    const r = row + dr * i;
    const c = col + dc * i;
    const key = cellKey(r, c);
    const existing = letters.get(key);
    if (existing !== undefined) {
      if (existing !== word[i]) return null; // conflicting letter
      crossings++;
    } else {
      // Perpendicular neighbors of a non-crossing cell must be empty, or
      // this would create an accidental adjacent word fragment.
      const pr1 = dir === 'H' ? r - 1 : r;
      const pc1 = dir === 'H' ? c : c - 1;
      const pr2 = dir === 'H' ? r + 1 : r;
      const pc2 = dir === 'H' ? c : c + 1;
      if (letters.has(cellKey(pr1, pc1))) return null;
      if (letters.has(cellKey(pr2, pc2))) return null;
    }
  }
  return { row, col, dir, crossings };
}

function findBestPlacement(word, letters, startKeys) {
  let best = null;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    for (const [key] of letters) {
      const [er, ec] = key.split(',').map(Number);
      if (letters.get(key) !== ch) continue;
      // Try placing this word crossing at (er,ec) in both orientations.
      // Horizontal: word's i-th letter lands at (er, ec) => start col = ec-i
      const hRow = er, hCol = ec - i;
      const hPlacement = tryPlacement(word, hRow, hCol, 'H', letters, startKeys);
      if (hPlacement && (!best || hPlacement.crossings > best.crossings)) best = hPlacement;
      // Vertical: word's i-th letter lands at (er, ec) => start row = er-i
      const vRow = er - i, vCol = ec;
      const vPlacement = tryPlacement(word, vRow, vCol, 'V', letters, startKeys);
      if (vPlacement && (!best || vPlacement.crossings > best.crossings)) best = vPlacement;
    }
  }
  return best;
}

export function generateCrossword(wordBank, opts = {}) {
  const targetWords = opts.targetWords ?? 12;
  const candidatePoolSize = opts.candidatePoolSize ?? 45;
  const seed = opts.seed ?? Math.floor(Math.random() * 4294967295);
  const rng = mulberry32(seed);

  const pool = shuffle(wordBank, rng).slice(0, candidatePoolSize);
  // Longer words first tend to make better anchors — but pick the actual
  // anchor randomly among the top few longest so the puzzle's starting
  // word (and everything built from it) varies between generations.
  pool.sort((a, b) => b.word.length - a.word.length);

  const letters = new Map(); // "r,c" -> letter
  const placed = []; // { word, clue, row, col, dir }
  const startKeys = new Set(); // "row,col,dir" for every placed word's start cell
  const remaining = pool.slice();

  const anchorPoolSize = Math.min(remaining.length, 6);
  const anchorIdx = Math.floor(rng() * anchorPoolSize);
  const first = remaining.splice(anchorIdx, 1)[0];
  for (let i = 0; i < first.word.length; i++) {
    letters.set(cellKey(0, i), first.word[i]);
  }
  placed.push({ word: first.word, clue: first.clue, row: 0, col: 0, dir: 'H' });
  startKeys.add('0,0,H');
  let bbox = { minR: 0, maxR: 0, minC: 0, maxC: first.word.length - 1 };

  function bboxDimsAfter(row, col, dir, len) {
    const endR = row + (dir === 'V' ? len - 1 : 0);
    const endC = col + (dir === 'H' ? len - 1 : 0);
    const newMinR = Math.min(bbox.minR, row), newMaxR = Math.max(bbox.maxR, endR);
    const newMinC = Math.min(bbox.minC, col), newMaxC = Math.max(bbox.maxC, endC);
    const h = newMaxR - newMinR + 1, w = newMaxC - newMinC + 1;
    return { area: h * w, width: w, height: h };
  }
  const oldArea = () => (bbox.maxR - bbox.minR + 1) * (bbox.maxC - bbox.minC + 1);

  // At each step, evaluate every remaining candidate's best placement, then
  // randomly pick among the top-scoring options (rather than always the
  // single global best) — scored by crossing count first (more shared
  // letters = denser grid), bounding-box growth and a squareness bias as
  // tie-breakers (a real newspaper crossword is compact and roughly square,
  // not a sprawling irregular shape). Picking only the single best every
  // time made generations converge on nearly the same word set regardless
  // of shuffle order; sampling from the top few keeps density high while
  // still varying.
  while (placed.length < targetWords && remaining.length > 0) {
    const candidates = []; // { idx, row, col, dir, crossings, score }
    for (let idx = 0; idx < remaining.length; idx++) {
      const entry = remaining[idx];
      const placement = findBestPlacement(entry.word, letters, startKeys);
      if (!placement) continue;
      const dims = bboxDimsAfter(placement.row, placement.col, placement.dir, entry.word.length);
      const areaGrowth = dims.area - oldArea();
      const squarenessPenalty = Math.abs(dims.width - dims.height);
      const score = placement.crossings * placement.crossings * 1000 - areaGrowth - squarenessPenalty * 3;
      candidates.push({ idx, row: placement.row, col: placement.col, dir: placement.dir, crossings: placement.crossings, score });
    }
    if (candidates.length === 0) break; // no remaining word can be placed at all
    candidates.sort((a, b) => b.score - a.score);
    const poolSize = Math.min(candidates.length, Math.max(3, Math.ceil(candidates.length * 0.25)));
    const bestOverall = candidates[Math.floor(rng() * poolSize)];
    const entry = remaining[bestOverall.idx];
    for (let i = 0; i < entry.word.length; i++) {
      const r = bestOverall.row + (bestOverall.dir === 'V' ? i : 0);
      const c = bestOverall.col + (bestOverall.dir === 'H' ? i : 0);
      letters.set(cellKey(r, c), entry.word[i]);
    }
    const len = entry.word.length;
    const endR = bestOverall.row + (bestOverall.dir === 'V' ? len - 1 : 0);
    const endC = bestOverall.col + (bestOverall.dir === 'H' ? len - 1 : 0);
    bbox = {
      minR: Math.min(bbox.minR, bestOverall.row), maxR: Math.max(bbox.maxR, endR),
      minC: Math.min(bbox.minC, bestOverall.col), maxC: Math.max(bbox.maxC, endC),
    };
    startKeys.add(bestOverall.row + ',' + bestOverall.col + ',' + bestOverall.dir);
    placed.push({ word: entry.word, clue: entry.clue, row: bestOverall.row, col: bestOverall.col, dir: bestOverall.dir });
    remaining.splice(bestOverall.idx, 1);
  }

  // Densification pass: after reaching the target word count, keep trying
  // to squeeze in MORE words from the wider bank that cross existing
  // letters without growing the footprint (or only growing it a little).
  // This is purely about adding overlaps — every extra word placed here
  // shares at least one letter with what's already there, so solving one
  // word reveals letters that help with another.
  const placedWords = new Set(placed.map((p) => p.word));
  let extraPool = shuffle(wordBank.filter((w) => !placedWords.has(w.word)), rng);
  const maxExtraWords = opts.maxExtraWords ?? Math.ceil(targetWords * 1.0);
  const areaGrowthCap = opts.extraAreaGrowthCap ?? 4; // allow a bit more growth to fit more overlaps
  let addedExtra = 0;
  let stillSearching = true;
  while (stillSearching && addedExtra < maxExtraWords) {
    stillSearching = false;
    for (let idx = 0; idx < extraPool.length; idx++) {
      const entry = extraPool[idx];
      const placement = findBestPlacement(entry.word, letters, startKeys);
      if (!placement || placement.crossings < 1) continue;
      const newArea = bboxDimsAfter(placement.row, placement.col, placement.dir, entry.word.length).area;
      const areaGrowth = newArea - oldArea();
      if (areaGrowth > areaGrowthCap) continue; // only accept near-free (in-footprint) additions
      for (let i = 0; i < entry.word.length; i++) {
        const r = placement.row + (placement.dir === 'V' ? i : 0);
        const c = placement.col + (placement.dir === 'H' ? i : 0);
        letters.set(cellKey(r, c), entry.word[i]);
      }
      const len = entry.word.length;
      const endR = placement.row + (placement.dir === 'V' ? len - 1 : 0);
      const endC = placement.col + (placement.dir === 'H' ? len - 1 : 0);
      bbox = {
        minR: Math.min(bbox.minR, placement.row), maxR: Math.max(bbox.maxR, endR),
        minC: Math.min(bbox.minC, placement.col), maxC: Math.max(bbox.maxC, endC),
      };
      startKeys.add(placement.row + ',' + placement.col + ',' + placement.dir);
      placed.push({ word: entry.word, clue: entry.clue, row: placement.row, col: placement.col, dir: placement.dir });
      extraPool.splice(idx, 1);
      addedExtra++;
      stillSearching = true;
      if (addedExtra >= maxExtraWords) break;
      break; // restart the scan since letters/bbox changed
    }
  }

  // Normalize coordinates to start at (0,0).
  let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
  for (const p of placed) {
    const len = p.word.length;
    const endR = p.row + (p.dir === 'V' ? len - 1 : 0);
    const endC = p.col + (p.dir === 'H' ? len - 1 : 0);
    minR = Math.min(minR, p.row); maxR = Math.max(maxR, endR);
    minC = Math.min(minC, p.col); maxC = Math.max(maxC, endC);
  }
  for (const p of placed) { p.row -= minR; p.col -= minC; }
  const height = maxR - minR + 1;
  const width = maxC - minC + 1;

  // Build the open-cell letter grid.
  const grid = Array.from({ length: height }, () => new Array(width).fill(null));
  for (const p of placed) {
    for (let i = 0; i < p.word.length; i++) {
      const r = p.row + (p.dir === 'V' ? i : 0);
      const c = p.col + (p.dir === 'H' ? i : 0);
      grid[r][c] = p.word[i];
    }
  }

  // Number cells: a cell starts an across clue if it's open, has no open
  // cell to its left, and has an open cell to its right; symmetric for down.
  function isOpen(r, c) { return r >= 0 && r < height && c >= 0 && c < width && grid[r][c] !== null; }
  const numbers = Array.from({ length: height }, () => new Array(width).fill(null));
  const acrossClues = [];
  const downClues = [];
  let num = 1;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!isOpen(r, c)) continue;
      const startsAcross = !isOpen(r, c - 1) && isOpen(r, c + 1);
      const startsDown = !isOpen(r - 1, c) && isOpen(r + 1, c);
      if (startsAcross || startsDown) {
        numbers[r][c] = num;
        if (startsAcross) {
          const p = placed.find((pp) => pp.dir === 'H' && pp.row === r && pp.col === c);
          acrossClues.push({ number: num, clue: p ? p.clue : '', answer: p ? p.word : '', row: r, col: c, length: p ? p.word.length : 0 });
        }
        if (startsDown) {
          const p = placed.find((pp) => pp.dir === 'V' && pp.row === r && pp.col === c);
          downClues.push({ number: num, clue: p ? p.clue : '', answer: p ? p.word : '', row: r, col: c, length: p ? p.word.length : 0 });
        }
        num++;
      }
    }
  }

  return { width, height, grid, numbers, acrossClues, downClues, wordCount: placed.length };
}
