// Plain-data vector shapes shared by the simulation, pure logic and adapters.
// Kept free of three.js so src/logic and src/data can use them (see design "모듈 의존 규칙").

/** 3D vector in world units (metres). Y is up. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 2D vector (screen space, or a horizontal XZ pair stored as x/y). */
export interface Vec2 {
  x: number;
  y: number;
}
