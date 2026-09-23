import ort from "./ort.wasm.min.js";
export default ort;
export const env = ort.env;
export const InferenceSession = ort.InferenceSession;
export const Tensor = ort.Tensor;
