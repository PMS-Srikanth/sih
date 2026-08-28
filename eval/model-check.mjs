import * as ort from "onnxruntime-web";
import { readFileSync } from "node:fs";

ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

const bytes = new Uint8Array(readFileSync("extension/public/models/ultraface-320.onnx"));
const t0 = performance.now();
const s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
console.log(`load        ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`inputs      ${s.inputNames.join(", ")}`);
console.log(`outputs     ${s.outputNames.join(", ")}`);

const IN_W = 320, IN_H = 240;
const data = new Float32Array(3 * IN_H * IN_W);
for (let i = 0; i < data.length; i++) data[i] = ((i * 37) % 255 - 127) / 128;

const t1 = performance.now();
const out = await s.run({ input: new ort.Tensor("float32", data, [1, 3, IN_H, IN_W]) });
const inferMs = performance.now() - t1;

const scores = out.scores, boxes = out.boxes;
console.log(`inference   ${inferMs.toFixed(1)} ms  (WASM, single thread)`);
console.log(`scores      dims [${scores.dims}]  ${scores.type}`);
console.log(`boxes       dims [${boxes.dims}]  ${boxes.type}`);

const n = scores.dims[1];
let max = 0;
for (let i = 0; i < n; i++) max = Math.max(max, scores.data[i * 2 + 1]);
console.log(`priors      ${n}`);
console.log(`max face p  ${max.toFixed(4)}  (noise input — should be low)`);

const ok = scores.dims.length === 3 && scores.dims[2] === 2 && boxes.dims[2] === 4 && n > 1000;
console.log(`\ncontract    ${ok ? "OK — shapes match the postprocessing" : "MISMATCH"}`);
process.exit(ok ? 0 : 1);
