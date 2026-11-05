/* Node unit tests for the scanner maths in public/scan.js.
   Run with `npm run test:scan`.

   The module is imported directly (it only touches the DOM inside openScanner()),
   so the geometry is proven here instead of by eye on a phone. Each case builds a
   synthetic frame whose right answer is known: a skewed bright quad on a dark desk,
   a page lit unevenly from one side, and a homography that must map corners onto
   the rectangle exactly. */

import assert from "node:assert/strict";
import {
  detectQuad, flattenLighting, orderQuad, quadArea, solveHomography, toGray, warpPage, warpSize,
} from "../public/scan.js";

let passed = 0;
const test = (name, run) => {
  try {
    run();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.message);
    process.exitCode = 1;
  }
};

/** A frame with a bright, perspective-skewed "sheet" on a dark background. */
function frameWithSheet(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const corners = [{ x: 60, y: 40 }, { x: 340, y: 62 }, { x: 318, y: 268 }, { x: 44, y: 248 }];
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cross === 0) continue;
      const current = cross > 0 ? 1 : -1;
      if (!sign) sign = current;
      else if (sign !== current) return false;
    }
    return true;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const value = inside(x, y) ? 232 : 38;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width, height, corners };
}

test("toGray follows Rec. 709 luma", () => {
  const gray = toGray(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1);
  assert.ok(Math.abs(gray[0] - 54.2) < 0.6, `red luma ${gray[0]}`);
  assert.ok(Math.abs(gray[1] - 182.4) < 0.6, `green luma ${gray[1]}`);
});

test("orderQuad returns corners clockwise from the top-left", () => {
  const shuffled = [
    { x: 300, y: 260 }, { x: 40, y: 30 }, { x: 20, y: 240 }, { x: 310, y: 20 },
  ];
  const ordered = orderQuad(shuffled);
  assert.deepEqual(ordered.map((p) => `${p.x},${p.y}`), ["40,30", "310,20", "300,260", "20,240"]);
});

test("quadArea is winding-independent", () => {
  const clockwise = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(quadArea(clockwise), 100);
  assert.equal(quadArea([...clockwise].reverse()), 100);
});

test("detectQuad finds the skewed sheet's four corners", () => {
  const frame = frameWithSheet(400, 300);
  const quad = detectQuad(toGray(frame.data, frame.width, frame.height), frame.width, frame.height);
  assert.ok(quad, "no quad detected");
  quad.forEach((point, index) => {
    const near = Math.hypot(point.x - frame.corners[index].x, point.y - frame.corners[index].y);
    assert.ok(near < 18, `corner ${index} is ${near.toFixed(1)}px off (${point.x},${point.y})`);
  });
});

test("detectQuad reports nothing on a blank dark frame", () => {
  const data = new Uint8ClampedArray(120 * 90 * 4).fill(20);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  assert.equal(detectQuad(toGray(data, 120, 90), 120, 90), null);

test("solveHomography maps each source corner onto its destination", () => {
  const src = [{ x: 60, y: 40 }, { x: 340, y: 62 }, { x: 318, y: 268 }, { x: 44, y: 248 }];
  const dst = [{ x: 0, y: 0 }, { x: 199, y: 0 }, { x: 199, y: 149 }, { x: 0, y: 149 }];
  const matrix = solveHomography(src, dst);
  assert.ok(matrix, "homography is degenerate");
  const [a, b, c, d, e, f, g, h] = matrix;
  src.forEach((point, index) => {
    const w = g * point.x + h * point.y + 1;
    const x = (a * point.x + b * point.y + c) / w;
    const y = (d * point.x + e * point.y + f) / w;
    assert.ok(Math.abs(x - dst[index].x) < 0.001, `x ${x} vs ${dst[index].x}`);
    assert.ok(Math.abs(y - dst[index].y) < 0.001, `y ${y} vs ${dst[index].y}`);
  });
});

test("solveHomography refuses a degenerate quad", () => {
  const src = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  const dst = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  assert.equal(solveHomography(src, dst), null);
});

test("warpSize keeps the detected aspect and caps the long edge", () => {
  const size = warpSize([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 800 }, { x: 0, y: 800 }], 1600);
  assert.equal(size.height, 1600);
  assert.equal(size.width, 1200);
  assert.equal(warpSize([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]), null);
});

test("warpPage renders the sheet as a full, straight page", () => {
  const frame = frameWithSheet(400, 300);
  const quad = orderQuad(frame.corners);
  const page = warpPage(frame.data, frame.width, frame.height, quad, 200, 150);
  assert.equal(page.width, 200);
  assert.equal(page.height, 150);
  let lit = 0;
  for (let i = 0; i < page.data.length; i += 4) if (page.data[i] > 200) lit += 1;
  const ratio = lit / (page.width * page.height);
  assert.ok(ratio > 0.97, `only ${(ratio * 100).toFixed(1)}% of the page is paper`);
});

test("warpPage survives a degenerate quad instead of returning a black page", () => {
  const frame = frameWithSheet(120, 90);
  const flat = [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }];
  const page = warpPage(frame.data, frame.width, frame.height, flat, 40, 30);
  let ink = 0;
  for (let i = 0; i < page.data.length; i += 4) if (page.data[i] > 0) ink += 1;
  assert.ok(ink > 0, "page came back black");
});

test("flattenLighting evens out a page lit from one side", () => {
  const width = 120;
  const height = 90;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const value = x < width / 2 ? 110 : 236;
      data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
    }
  }
  flattenLighting({ data, width, height });
  const left = data[(45 * width + 20) * 4];
  const right = data[(45 * width + 100) * 4];
  assert.ok(left > 200, `shadowed side stayed at ${left}`);
  assert.ok(Math.abs(left - right) < 45, `sides disagree: ${left} vs ${right}`);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? " — with failures" : ""}`);

});
