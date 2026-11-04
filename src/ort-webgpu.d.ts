// onnxruntime-web's "./webgpu" entry has no "types" condition; it exposes the same API as onnxruntime-common.
declare module 'onnxruntime-web/webgpu' {
  export * from 'onnxruntime-common'
}
