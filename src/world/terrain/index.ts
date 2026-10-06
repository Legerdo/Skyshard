// Terrain heightfield: generation, queries and the static features it is shaped around.
export * from './buildTerrain';
export * from './features';
export { createNoise2D, fbm, ridged, type Noise2D } from './noise';
export { WATER_BODIES, distanceToRiver, waterLevelAt, type RiverBody, type WaterBody } from './waterBodies';
