//! NVENC, the first-class encoder backend. Task 3.7 fills it.
//!
//! Exposes `probe() -> BackendCaps` and `create(&EncoderConfig) ->
//! Result<Box<dyn Encoder>>` and nothing else. nvEncodeAPI64.dll is loaded by
//! absolute path at runtime, so a machine with no NVIDIA driver fails `probe()`
//! instead of failing to start.
