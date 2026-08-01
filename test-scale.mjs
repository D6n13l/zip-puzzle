import { generatePuzzle, hashStringToSeed } from './gen.js';

const configs = [
  { name: '7x7-d8',  n: 7, dots: 8,  extraWallBudget: 0 },
  { name: '8x8-d9',  n: 8, dots: 9,  extraWallBudget: 0 },
  { name: '8x8-d8',  n: 8, dots: 8,  extraWallBudget: 0 },
  { name: '9x9-d9',  n: 9, dots: 9,  extraWallBudget: 0 },
];

for (const cfg of configs) {
  console.log(`\n=== ${cfg.name} ===`);
  let uniqueCount = 0, total = 5, sumWalls=0, maxTime=0, sumTime=0;
  for (let i = 0; i < total; i++) {
    const seed = hashStringToSeed(cfg.name + '-scale-' + i);
    const t0 = Date.now();
    const puzzle = generatePuzzle(cfg.n, cfg.dots, seed, { extraWallBudget: cfg.extraWallBudget, nodeBudget: 300000, maxRetries: 10 });
    const dt = Date.now() - t0;
    sumTime += dt; maxTime = Math.max(maxTime, dt); sumWalls += puzzle.walls.length;
    if (puzzle.unique) uniqueCount++;
    console.log(`  run ${i}: unique=${puzzle.unique} walls=${puzzle.walls.length} time=${dt}ms`);
  }
  console.log(`  -> unique ${uniqueCount}/${total}, avg walls ${(sumWalls/total).toFixed(1)}, avg time ${(sumTime/total).toFixed(0)}ms, max ${maxTime}ms`);
}
