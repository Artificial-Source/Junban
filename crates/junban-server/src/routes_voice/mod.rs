//! Operator-only bounded cloud speech routes.

mod error;
mod handlers;
mod multipart;

#[cfg(test)]
mod tests;

pub use handlers::{
    __path_create_voice_speech, __path_create_voice_transcription, SpeechBinaryResponse,
    SpeechSynthesisRequest, SpeechTranscriptionMultipart, TranscriptionResponse,
    create_voice_speech, create_voice_transcription,
};
