use std::{env, fs, io, path::PathBuf};

fn main() -> io::Result<()> {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("usage: generate-openapi <output-path>"))?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, junban_server::openapi_json())
}
