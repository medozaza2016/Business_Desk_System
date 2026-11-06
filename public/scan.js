/* Challenger Quotation Desk — single-page document scanner.
   ----------------------------------------------------------------------------
   No SDK, no WASM, no CDN: the geometry is a homography solved from the four
   detected corners, applied to the camera frame pixel by pixel. That keeps the
   whole scanner inside the Worker's CSP (`script-src 'self'`) and inside a phone's
   memory budget.

   Two halves:
     1. pure maths  — toGray / orderQuad / detectQuad / solveHomography / warpPage,
        all typed-array functions so they can be unit-tested in Node
        (`npm run test:scan`), with no reference to window or document;
     2. camera shell — openScanner(), a modal that streams the back camera, tracks
        the sheet live, lets the operator drag the four corners, and resolves with a
        corrected JPEG.

   The output is a page, not a photocopy: shadows are divided out by a per-pixel
   background estimate, so a picture taken across a desk lamp still reads as paper
   while the ink signature and the red stamp keep their colour.
   */

/** @typedef {{x:number, y:number}} Point */

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/* ================================ maths ================================ */

/** Rec. 709 luma of an RGBA buffer, as a 0..255 float array. */
export function toGray(data, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return gray;
}

/** Summed-area table with a zero row/column, so box means need no edge cases. */
export function integralImage(gray, width, height) {
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      rowSum += gray[row + x];
      sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + rowSum;
    }
  }
  return sum;
}

/** Box mean through the integral image; the window is clamped at the border. */
export function boxBlur(gray, width, height, radius) {
  const sum = integralImage(gray, width, height);
  const stride = width + 1;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const total = sum[(y1 + 1) * stride + x1 + 1] - sum[y0 * stride + x1 + 1] -
        sum[(y1 + 1) * stride + x0] + sum[y0 * stride + x0];
      out[y * width + x] = total / area;
    }
  }
  return out;
}

/** Otsu's threshold: the split that minimises the within-class variance. */
export function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, Math.round(gray[i])))] += 1;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let weightLow = 0;
  let sumLow = 0;
  let best = 0;
  let bestVariance = -1;
  for (let t = 0; t < 256; t++) {
    weightLow += hist[t];
    if (!weightLow) continue;
    const weightHigh = total - weightLow;
    if (!weightHigh) break;
    sumLow += t * hist[t];
    const meanLow = sumLow / weightLow;
    const meanHigh = (sumAll - sumLow) / weightHigh;
    const variance = weightLow * weightHigh * (meanLow - meanHigh) * (meanLow - meanHigh);
    if (variance > bestVariance) { bestVariance = variance; best = t; }
  }
  return best;
}


/**
 * The four extreme points of a binary blob: for a sheet held at any angle the
 * smallest x+y is the top-left corner, the largest the bottom-right, and the x−y
 * extremes give the other two. Cheaper and steadier than a Hough fit.
 * @param {Uint8Array} mask @returns {Point[]|null}
 */
export function quadFromMask(mask, width, height) {
  let area = 0;
  let tl = -1, tr = -1, br = -1, bl = -1;
  let tlScore = Infinity, trScore = -Infinity, brScore = -Infinity, blScore = Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      area++;
      const add = x + y;
      const diff = x - y;
      if (add < tlScore) { tlScore = add; tl = y * width + x; }
      if (add > brScore) { brScore = add; br = y * width + x; }
      if (diff > trScore) { trScore = diff; tr = y * width + x; }
      if (diff < blScore) { blScore = diff; bl = y * width + x; }
    }
  }
  if (area < width * height * 0.08) return null;
  if (tl < 0 || tr < 0 || br < 0 || bl < 0) return null;
  return [tl, tr, br, bl].map((index) => ({ x: index % width, y: Math.floor(index / width) }));
}

/** Shoelace area of a quad, whatever its winding. */
export function quadArea(quad) {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total) / 2;
}

/**
 * Sorts four points clockwise from the top-left. Detectors hand corners back in no
 * particular order, and the homography needs the correspondence to be consistent.
 * @param {Point[]} points @returns {Point[]}
 */
export function orderQuad(points) {
  const centre = points.reduce((acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }), { x: 0, y: 0 });
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - centre.y, a.x - centre.x) - Math.atan2(b.y - centre.y, b.x - centre.x)
  );
  /* atan2 starts at +x (the right edge). Rotate until the top-left-ish point leads. */
  let start = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const score = sorted[i].x + sorted[i].y;
    if (score < bestScore) { bestScore = score; start = i; }
  }
  return [0, 1, 2, 3].map((offset) => sorted[(start + offset) % 4]);
}

/**
 * Keeps the largest bright region (the sheet) and returns its corners in the order
 * top-left → top-right → bottom-right → bottom-left.
 * @param {Float32Array} gray @returns {Point[]|null}
 */
export function detectQuad(gray, width, height) {
  const blurred = boxBlur(gray, width, height, 2);
  const threshold = otsuThreshold(blurred);
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const mask = new Uint8Array(width * height);
  let bestArea = 0;
  for (let start = 0; start < blurred.length; start++) {
    if (visited[start] || blurred[start] <= threshold) continue;
    let top = 0;
    const members = [];
    stack[top++] = start;
    visited[start] = 1;
    while (top) {
      const index = stack[--top];
      members.push(index);
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0 && !visited[index - 1] && blurred[index - 1] > threshold) { visited[index - 1] = 1; stack[top++] = index - 1; }
      if (x + 1 < width && !visited[index + 1] && blurred[index + 1] > threshold) { visited[index + 1] = 1; stack[top++] = index + 1; }
      if (y > 0 && !visited[index - width] && blurred[index - width] > threshold) { visited[index - width] = 1; stack[top++] = index - width; }
      if (y + 1 < height && !visited[index + width] && blurred[index + width] > threshold) { visited[index + width] = 1; stack[top++] = index + width; }
    }
    if (members.length > bestArea) {
      bestArea = members.length;
      mask.fill(0);
      for (const index of members) mask[index] = 1;
    }
  }
  if (bestArea < width * height * 0.08) return null;
  /* a blob that fills the frame means nothing was isolated (flat light, or the
     sheet already fills the shot), and the caller's whole-frame quad is the better
     answer then: report "no page found" instead of inventing one */
  if (bestArea > width * height * 0.96) return null;
  const quad = quadFromMask(mask, width, height);
  if (!quad) return null;
  const ordered = orderQuad(quad);
  return quadArea(ordered) >= width * height * 0.08 ? ordered : null;
}

/**
 * 3×3 homography mapping four source points onto four destination points.
 * Solves the 8×8 system by Gaussian elimination with partial pivoting.
 * @returns {Float64Array|null} row-major 9 values, or null when degenerate
 */
export function solveHomography(src, dst) {
  const a = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
    }
    const divisor = a[col][col];
    for (let k = col; k < 8; k++) a[col][k] /= divisor;
    b[col] /= divisor;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (!factor) continue;
      for (let k = col; k < 8; k++) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }
  return Float64Array.from([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1]);
}

/** Bilinear RGBA sample; out-of-range reads clamp to the edge. */
export function sampleBilinear(src, width, height, x, y, out) {
  const cx = clamp01(x / Math.max(width - 1, 1)) * (width - 1);
  const cy = clamp01(y / Math.max(height - 1, 1)) * (height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
    const bottom = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

/** Size of the corrected page: the detected aspect, capped on the long edge. */
export function warpSize(quad, maxEdge = 1600) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wide = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const tall = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  if (!(wide > 4) || !(tall > 4)) return null;
  const scale = Math.min(maxEdge / Math.max(wide, tall), 3);
  return { width: Math.max(1, Math.round(wide * scale)), height: Math.max(1, Math.round(tall * scale)) };
}

/**
 * Straightens the quad into a rectangle.
 * @param {Uint8ClampedArray} src RGBA of the camera frame
 * @returns {{data:Uint8ClampedArray,width:number,height:number}}
 */
export function warpPage(src, srcWidth, srcHeight, quad, outWidth, outHeight) {
  const dst = [
    { x: 0, y: 0 },
    { x: outWidth - 1, y: 0 },
    { x: outWidth - 1, y: outHeight - 1 },
    { x: 0, y: outHeight - 1 },
  ];
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const pixel = new Float64Array(3);
  /* solved dest → source: the loop walks the page and asks where each pixel came
     from, which is the only way to fill every output pixel exactly once */
  const matrix = solveHomography(dst, quad);

  if (!matrix) {
    /* no usable geometry: a plain centre crop, never a black page */
    const scale = Math.min(srcWidth / outWidth, srcHeight / outHeight);
    const offX = (srcWidth - outWidth * scale) / 2;
    const offY = (srcHeight - outHeight * scale) / 2;
    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        sampleBilinear(src, srcWidth, srcHeight, offX + x * scale, offY + y * scale, pixel);
        const i = (y * outWidth + x) * 4;
        out[i] = pixel[0]; out[i + 1] = pixel[1]; out[i + 2] = pixel[2]; out[i + 3] = 255;
      }
    }
    return { data: out, width: outWidth, height: outHeight };
  }

  const [a, b, c, d, e, f, g, h] = matrix;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const denominator = g * x + h * y + 1;
      const sx = (a * x + b * y + c) / denominator;
      const sy = (d * x + e * y + f) / denominator;
      sampleBilinear(src, srcWidth, srcHeight, sx, sy, pixel);
      const i = (y * outWidth + x) * 4;
      out[i] = pixel[0]; out[i + 1] = pixel[1]; out[i + 2] = pixel[2]; out[i + 3] = 255;
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/**
 * Divides the warped page by a heavily blurred copy of itself (a cheap flat-field
 * correction), per channel. Every paper pixel then reads as white and the lamp's
 * colour stops tinting it: shadows, falloff and a tungsten bulb all cancel out,
 * while ink and the red stamp keep their colour.
 */
export function flattenLighting(page, options = {}) {
  const { data, width, height } = page;
  const radius = typeof options === "number" ? options : Number(options.radius) || 0;
  const balanced = typeof options === "number" || options.whiteBalance !== false;
  /* the background estimate is built on a coarse grid — far cheaper, same result —
     and kept per channel: dividing each channel by its own backdrop cancels the
     lamp's warm or cool cast at the same time as its falloff, which is why a photo
     taken under an incandescent bulb stops coming back yellow */
  const gw = Math.max(2, Math.round(width / 4));
  const gh = Math.max(2, Math.round(height / 4));
  const planes = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  for (let y = 0; y < gh; y++) {
    const sy = Math.min(height - 1, Math.round((y / (gh - 1)) * (height - 1)));
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(width - 1, Math.round((x / (gw - 1)) * (width - 1)));
      const i = (sy * width + sx) * 4;
      const cell = y * gw + x;
      planes[0][cell] = data[i];
      planes[1][cell] = data[i + 1];
      planes[2][cell] = data[i + 2];
    }
  }
  const blurRadius = radius || Math.max(8, Math.round(Math.min(width, height) / 24));
  const background = planes.map((plane) => boxBlur(plane, gw, gh, Math.max(2, Math.round(blurRadius / 4))));
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.round((y / (height - 1)) * (gh - 1)));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(gw - 1, Math.round((x / (width - 1)) * (gw - 1)));
      const cell = gy * gw + gx;
      const red = background[0][cell];
      const green = background[1][cell];
      const blue = background[2][cell];
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      /* the 40 floor keeps a dark background from blowing up sensor noise */
      const gain = Math.min(255 / Math.max(luma, 40), 4);
      const i = (y * width + x) * 4;
      data[i] = data[i] * gain * (balanced ? channelGain(red, luma) : 1);
      data[i + 1] = data[i + 1] * gain * (balanced ? channelGain(green, luma) : 1);
      data[i + 2] = data[i + 2] * gain * (balanced ? channelGain(blue, luma) : 1);
    }
  }
  return page;
}

/**
 * Per-channel correction factor, bounded so a large coloured block (a red header,
 * a stamp) cannot swing the hue of the whole page.
 */
const channelGain = (channel, luma) => {
  if (!(channel > 0)) return 1;
  return Math.min(1.45, Math.max(0.7, luma / channel));
};

/** Value below which `fraction` of the samples fall, from a 256-bin histogram. */
export function percentile(values, fraction) {
  const bins = new Float64Array(256);
  for (let i = 0; i < values.length; i++) bins[Math.min(255, Math.max(0, Math.round(values[i])))] += 1;
  const target = Math.max(1, Math.round(values.length * fraction));
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += bins[value];
    if (seen >= target) return value;
  }
  return 255;
}

/**
 * The finish applied after the page is straightened and flattened:
 *   "colour" — a levels stretch that puts the paper at white and the ink at black
 *              while keeping the pen and the stamp in colour;
 *   "grey"   — the same stretch on luma only: a plain photocopy of the page.
 */
export function paperTone(page, mode = "colour") {
  const { data, width, height } = page;
  const gray = toGray(data, width, height);
  const black = percentile(gray, 0.01);
  const white = percentile(gray, 0.985);
  const span = white - black;
  /* a page that already reads flat is left alone: stretching it would amplify
     sensor noise instead of ink */
  if (span < 24) return page;
  const scale = 255 / span;
  const grey = mode === "grey";
  for (let p = 0; p < data.length; p += 4) {
    const red = (data[p] - black) * scale;
    const green = (data[p + 1] - black) * scale;
    const blue = (data[p + 2] - black) * scale;
    if (grey) {
      const value = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
    } else {
      data[p] = red;
      data[p + 1] = green;
      data[p + 2] = blue;
    }
  }
  return page;
}

/* ============================= camera shell ============================= */
/* Everything below touches the DOM; the maths above stays testable in Node. */

const DETECT_WIDTH = 320;      // detection runs on a thumbnail, not the sensor frame
const DETECT_INTERVAL = 130;   // ms between detections: 8 fps feels live without heat
const MAX_FRAME_EDGE = 2200;   // full-resolution frame cap, keeps the warp under ~50 ms

/** Fit (contain) a vw×vh frame inside boxW×boxH and centre it. */
function fitRect(vw, vh, boxW, boxH) {
  const scale = Math.min(boxW / vw, boxH / vh) || 1;
  return { scale, width: Math.round(vw * scale), height: Math.round(vh * scale), dx: (boxW - vw * scale) / 2, dy: (boxH - vh * scale) / 2 };
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** A canvas wrapped in a promise: toBlob still uses callbacks. */
const canvasToBlob = (canvas, type = "image/jpeg", quality = 0.85) =>
  new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));

/**
 * Opens the scanner and resolves with the corrected page.
 * @param {{title?:string, hint?:string}} [options]
 * @returns {Promise<{blob:Blob,width:number,height:number}|null>} null when dismissed
 */
export function openScanner(options = {}) {
  /* No camera API (older browsers, insecure origins) or no permission: the phone's
     own camera picker still produces the same corrected page through this path. */
  return withCameraOrFile(options);
}

async function withCameraOrFile(options) {
  const stream = await startStream();
  if (!stream) return captureFromPicker();
  return runScanner(stream, options);
}

/** Back camera, ideal 1920×1080; null when unavailable or refused. */
async function startStream() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch {
    return null;
  }
}

/**
 * The picker path: decode the chosen photo, detect the sheet and run the same
 * warp, so a file chosen from the gallery gets the identical treatment.
 */
function captureFromPicker() {
  return new Promise((resolve) => {
    const input = element("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment");
    input.style.display = "none";
    document.body.append(input);
    const finish = (value) => { input.remove(); resolve(value); };
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return finish(null);
      finish(await processPhotoFile(file));
    });
    /* a cancelled picker fires no change event in most browsers */
    input.addEventListener("cancel", () => finish(null));
    input.click();
  });
}

/** Downscaled copy of a frame plus its luma, for detection. */
function detectionThumb(frame) {
  if (frame.width <= DETECT_WIDTH) {
    return { gray: toGray(frame.data, frame.width, frame.height), width: frame.width, height: frame.height };
  }
  const width = DETECT_WIDTH;
  const height = Math.max(1, Math.round(frame.height * (DETECT_WIDTH / frame.width)));
  const full = element("canvas");
  full.width = frame.width;
  full.height = frame.height;
  full.getContext("2d").putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);

  const canvas = element("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingQuality = "high";
  context.drawImage(full, 0, 0, width, height);
  const small = context.getImageData(0, 0, width, height);
  return { gray: toGray(small.data, width, height), width, height };
}

/** Warp, flatten, tone and encode. Resolves {blob,width,height} or null. */
async function renderPage(frame, quad, tone = "colour") {
  const size = warpSize(quad, 1600) || { width: 1240, height: 1754 };
  const page = warpPage(frame.data, frame.width, frame.height, quad, size.width, size.height);
  flattenLighting(page);
  paperTone(page, tone);
  const canvas = element("canvas");
  canvas.width = page.width;
  canvas.height = page.height;
  const context = canvas.getContext("2d");
  /* copied into a canvas-owned buffer: ImageData wants a plain ArrayBuffer, not the
     generic view the maths functions hand back */
  const image = context.createImageData(page.width, page.height);
  image.data.set(page.data);
  context.putImageData(image, 0, 0);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.85);
  return blob ? { blob, width: page.width, height: page.height } : null;
}

/** Full frame of a bitmap, capped on the long edge. */
function frameFromBitmap(bitmap) {
  const wide = bitmap.width || 0;
  const tall = bitmap.height || 0;
  if (!wide || !tall) return null;
  const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(wide, tall));
  const width = Math.max(1, Math.round(wide * scale));
  const height = Math.max(1, Math.round(tall * scale));
  const canvas = element("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === "function") bitmap.close();
  return context.getImageData(0, 0, width, height);
}

/** Detect on the frame as a whole; falls back to the full frame when unsure. */
async function pageFromBitmap(bitmap, tone = "colour") {
  const frame = frameFromBitmap(bitmap);
  if (!frame) return null;
  const thumb = detectionThumb(frame);
  const found = thumb ? detectQuad(thumb.gray, thumb.width, thumb.height) : null;
  const quad = found
    ? found.map((point) => ({ x: (point.x / thumb.width) * frame.width, y: (point.y / thumb.height) * frame.height }))
    : [{ x: 0, y: 0 }, { x: frame.width - 1, y: 0 }, { x: frame.width - 1, y: frame.height - 1 }, { x: 0, y: frame.height - 1 }];
  return renderPage(frame, quad, tone);
}

/**
 * A photo chosen from the gallery or the file system, corrected exactly like a
 * capture: detect the sheet, straighten it, flatten the light, then tone it.
 * Exported so the record page's "Upload a photo" runs the same pipeline instead of
 * storing whatever the camera app happened to produce.
 * @param {Blob} file
 * @param {"colour"|"grey"} [tone]
 * @returns {Promise<{blob:Blob,width:number,height:number}|null>}
 */
export async function processPhotoFile(file, tone = "colour") {
  try {
    const bitmap = await createImageBitmap(file);
    return await pageFromBitmap(bitmap, tone);
  } catch {
    return null;
  }
}


/* ------------------------------- the modal ------------------------------- */

const DPR = () => (typeof devicePixelRatio === "number" ? Math.min(devicePixelRatio, 3) : 1);

/**
 * Live view: video + corner overlay, then a frozen frame with draggable corners.
 * Resolves {blob,width,height} or null when dismissed.
 */
function runScanner(stream, options) {
  return new Promise((resolve) => {
    const dialog = element("dialog", "scanner");
    dialog.setAttribute("aria-label", options.title || "Scan the signed page");

    const card = element("div", "scanner-card");
    const head = element("header", "scanner-head");
    const titles = element("div", "scanner-titles");
    titles.append(
      element("p", "eyebrow", options.eyebrow || "Signed copy"),
      element("h2", "scanner-title", options.title || "Scan the signed page")
    );
    const closeBtn = element("button", "btn ghost small", "Close");
    closeBtn.type = "button";
    head.append(titles, closeBtn);

    const stage = element("div", "scanner-stage");
    const video = element("video", "scanner-media");
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.setAttribute("playsinline", "");
    const photo = element("canvas", "scanner-media");
    photo.hidden = true;
    const outline = element("canvas", "scanner-outline");
    const handleLayer = element("div", "scanner-handles");
    stage.append(video, photo, outline, handleLayer);

    /* The control bar sits above the picture on purpose: on a phone the bottom of
       the screen is where the browser puts its own chrome and the gesture bar, and a
       shutter the thumb cannot reach is a shutter that gets missed. */
    const foot = element("footer", "scanner-foot");
    const status = element("span", "scanner-status", "starting the camera…");
    const actions = element("div", "scanner-actions");
    const toneGroup = element("div", "scanner-modes");
    toneGroup.setAttribute("role", "group");
    toneGroup.setAttribute("aria-label", "Page finish");
    const retakeBtn = /** @type {HTMLButtonElement} */ (element("button", "btn ghost", "Retake"));
    const useBtn = /** @type {HTMLButtonElement} */ (element("button", "btn primary", "Use this page"));
    const captureBtn = /** @type {HTMLButtonElement} */ (element("button", "btn primary", "Capture"));
    for (const button of [retakeBtn, useBtn, captureBtn]) button.type = "button";
    retakeBtn.hidden = true;
    useBtn.hidden = true;
    toneGroup.hidden = true;
    const toneButtons = [["colour", "Colour"], ["grey", "Grey & white"]].map(([value, label]) => {
      const button = /** @type {HTMLButtonElement} */ (element("button", "scanner-mode", label));
      button.type = "button";
      button.dataset.tone = value;
      button.setAttribute("aria-pressed", "false");
      toneGroup.append(button);
      return button;
    });
    actions.append(toneGroup, retakeBtn, useBtn, captureBtn);
    foot.append(status, actions);

    card.append(head, foot, stage);
    dialog.append(card);
    document.body.append(dialog);
    dialog.showModal();

    /** @type {{x:number,y:number}[]|null} */
    let quad = null;
    /** @type {ImageData|null} */
    let frame = null;
    let mode = "live";
    /** @type {"colour"|"grey"} */
    let tone = "colour";
    let dragging = -1;
    let closed = false;
    let timer = 0;

    const paintTone = () => {
      for (const button of toneButtons) {
        button.setAttribute("aria-pressed", String(button.dataset.tone === tone));
      }
      /* the frozen frame approximates the finish so the choice is visible before the
         warp runs; the page itself is rendered when the operator taps "Use this page" */
      photo.style.filter = tone === "grey" ? "grayscale(1) contrast(1.08)" : "";
    };

    for (const button of toneButtons) {
      button.addEventListener("click", () => {
        tone = button.dataset.tone === "grey" ? "grey" : "colour";
        paintTone();
        status.textContent = tone === "grey"
          ? "Grey & white — a plain photocopy of the page."
          : "Colour — paper white, pen and stamp as signed.";
        status.dataset.state = "ok";
      });
    }

    paintTone();

    const handles = [0, 1, 2, 3].map(() => {
      const handle = /** @type {HTMLButtonElement} */ (element("button", "scanner-handle"));
      handle.type = "button";
      handle.setAttribute("aria-label", "Drag to the paper corner");
      handleLayer.append(handle);
      return handle;
    });

    const media = () => (mode === "live" ? video : photo);


    /** Fits the active media into the stage and sizes the overlay to match. */
    const layout = () => {
      const el = media();
      const vw = mode === "live" ? video.videoWidth : photo.width;
      const vh = mode === "live" ? video.videoHeight : photo.height;
      if (!vw || !vh) return null;
      const boxW = stage.clientWidth;
      const boxH = stage.clientHeight;
      if (!boxW || !boxH) return null;
      const fit = fitRect(vw, vh, boxW, boxH);
      el.style.width = `${fit.width}px`;
      el.style.height = `${fit.height}px`;
      el.style.left = `${fit.dx}px`;
      el.style.top = `${fit.dy}px`;
      const ratio = DPR();
      outline.width = Math.round(boxW * ratio);
      outline.height = Math.round(boxH * ratio);
      outline.style.width = `${boxW}px`;
      outline.style.height = `${boxH}px`;
      return { ...fit, ratio };
    };

    const placeHandles = (fit) => {
      const visible = mode === "review" && Boolean(quad);
      handleLayer.hidden = !visible;
      if (!visible || !quad) return;
      quad.forEach((point, index) => {
        const handle = handles[index];
        handle.style.left = `${fit.dx + point.x * fit.scale}px`;
        handle.style.top = `${fit.dy + point.y * fit.scale}px`;
        handle.dataset.corner = ["tl", "tr", "br", "bl"][index];
      });
    };

    const draw = () => {
      const fit = layout();
      if (!fit) return;
      const context = outline.getContext("2d");
      context.clearRect(0, 0, outline.width, outline.height);
      if (!quad) return;
      context.save();
      context.scale(fit.ratio, fit.ratio);
      context.beginPath();
      quad.forEach((point, index) => {
        const x = fit.dx + point.x * fit.scale;
        const y = fit.dy + point.y * fit.scale;
        if (index) context.lineTo(x, y); else context.moveTo(x, y);
      });
      context.closePath();
      context.fillStyle = "rgba(197,30,37,.10)";
      context.fill();
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.strokeStyle = "#c51e25";
      context.stroke();
      context.restore();
      placeHandles(fit);
    };

    const tearDown = () => {
      closed = true;
      clearTimeout(timer);
      window.removeEventListener("resize", draw);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      if (dialog.open) dialog.close();
      dialog.remove();
    };

    const close = (value) => {
      if (closed) return;
      tearDown();
      resolve(value);
    };

    const detect = () => {
      if (closed || mode !== "live") return;
      if (video.readyState >= 2 && video.videoWidth) {
        const canvas = element("canvas");
        canvas.width = DETECT_WIDTH;
        canvas.height = Math.max(1, Math.round(DETECT_WIDTH * (video.videoHeight / video.videoWidth)));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const small = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = detectQuad(toGray(small.data, small.width, small.height), small.width, small.height);
        if (found) {
          quad = found.map((point) => ({
            x: (point.x / canvas.width) * video.videoWidth,
            y: (point.y / canvas.height) * video.videoHeight,
          }));
          status.textContent = "Page found — hold still.";
          status.dataset.state = "ok";
        } else if (!quad) {
          status.textContent = "Fill the frame with the sheet…";
        }
        draw();
      }
      timer = window.setTimeout(detect, DETECT_INTERVAL);
    };

    const capture = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(vw, vh));
      photo.width = Math.round(vw * scale);
      photo.height = Math.round(vh * scale);
      const context = photo.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, 0, 0, photo.width, photo.height);
      frame = context.getImageData(0, 0, photo.width, photo.height);
      const whole = [
        { x: 0, y: 0 }, { x: photo.width - 1, y: 0 },
        { x: photo.width - 1, y: photo.height - 1 }, { x: 0, y: photo.height - 1 },
      ];
      quad = (quad || whole).map((point) => ({
        x: Math.min(point.x * scale, photo.width - 1),
        y: Math.min(point.y * scale, photo.height - 1),
      }));
      mode = "review";
      video.hidden = true;
      photo.hidden = false;
      captureBtn.hidden = true;
      retakeBtn.hidden = false;
      useBtn.hidden = false;
      toneGroup.hidden = false;
      status.textContent = "Drag the corners onto the paper edge, then use the page.";
      status.dataset.state = "ok";
      draw();
    };

    const retake = () => {
      mode = "live";
      photo.hidden = true;
      video.hidden = false;
      quad = null;
      captureBtn.hidden = false;
      retakeBtn.hidden = true;
      useBtn.hidden = true;
      toneGroup.hidden = true;
      status.textContent = "Fill the frame with the sheet…";
      delete status.dataset.state;
      draw();
      detect();
    };

    const usePage = async () => {
      if (!frame || !quad) return;
      useBtn.disabled = true;
      retakeBtn.disabled = true;
      status.textContent = "Correcting the page…";
      try {
        const page = await renderPage(frame, orderQuad(quad), tone);
        close(page);
      } catch {
        status.textContent = "That page could not be processed. Try another capture.";
        status.dataset.state = "error";
        useBtn.disabled = false;
        retakeBtn.disabled = false;
      }
    };

    handles.forEach((handle, index) => {
      handle.addEventListener("pointerdown", (event) => {
        dragging = index;
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener("pointermove", (event) => {
        if (dragging !== index || !quad) return;
        const box = photo.getBoundingClientRect();
        if (!box.width || !box.height) return;
        quad[index] = {
          x: clamp01((event.clientX - box.left) / box.width) * (photo.width - 1),
          y: clamp01((event.clientY - box.top) / box.height) * (photo.height - 1),
        };
        draw();
      });
      const release = () => { dragging = -1; };
      handle.addEventListener("pointerup", release);
      handle.addEventListener("pointercancel", release);
    });

    captureBtn.addEventListener("click", capture);
    retakeBtn.addEventListener("click", retake);
    useBtn.addEventListener("click", usePage);
    closeBtn.addEventListener("click", () => close(null));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(null); });
    window.addEventListener("resize", draw);
    video.addEventListener("loadeddata", () => {
      status.textContent = "Fill the frame with the sheet…";
      draw();
    });

    video.srcObject = stream;
    video.play().catch(() => { /* an autoplay refusal still paints the first frame */ });

    /* A camera that never delivers a frame (permission revoked, another app holding
       it) must not dead-end the operator: fall back to the phone's own picker. */
    timer = window.setTimeout(() => {
      if (closed || video.videoWidth) return;
      tearDown();
      captureFromPicker().then(resolve);
    }, 6000);

    detect();
  });
}
