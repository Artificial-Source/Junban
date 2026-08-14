use std::io;

fn main() {
    let mut stdout = io::stdout();
    let result = junban_plugin_host::run_child(&mut io::stdin().lock(), &mut stdout);
    if let Err(error) = result {
        eprintln!("junban-plugin-host: {error}");
        std::process::exit(1);
    }
}
