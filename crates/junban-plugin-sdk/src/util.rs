use sha2::{Digest, Sha256};

use crate::error::{Result, SdkError};

pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(char::from(DIGITS[usize::from(byte >> 4)]));
        value.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    value
}

pub(crate) fn decode_hex_32(value: &str, field: &'static str) -> Result<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(SdkError::Manifest { field });
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (nibble(pair[0]).ok_or(SdkError::Manifest { field })? << 4)
            | nibble(pair[1]).ok_or(SdkError::Manifest { field })?;
    }
    Ok(decoded)
}

fn nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

pub(crate) fn put_u32(out: &mut Vec<u8>, value: usize) -> Result<()> {
    out.extend_from_slice(
        &u32::try_from(value)
            .map_err(|_| SdkError::Length {
                field: "framed material",
            })?
            .to_be_bytes(),
    );
    Ok(())
}

pub(crate) fn is_canonical_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

pub(crate) fn validate_visible(
    value: &str,
    min: usize,
    max: usize,
    multiline: bool,
    field: &'static str,
) -> Result<()> {
    if value.len() < min || value.len() > max {
        return Err(SdkError::Manifest { field });
    }
    for character in value.chars() {
        let code = u32::from(character);
        let disallowed_control = (code <= 0x1f && !(multiline && matches!(character, '\n' | '\t')))
            || (0x7f..=0x9f).contains(&code);
        let bidi = matches!(code, 0x202a..=0x202e | 0x2066..=0x2069);
        if disallowed_control || bidi {
            return Err(SdkError::Manifest { field });
        }
    }
    Ok(())
}

pub(crate) fn validate_sorted_unique<T: Ord>(values: &[T], field: &'static str) -> Result<()> {
    if values.windows(2).any(|window| window[0] >= window[1]) {
        return Err(SdkError::Order { field });
    }
    Ok(())
}
