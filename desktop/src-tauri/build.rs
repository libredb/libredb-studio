fn main() {
    // Record the target triple so the shell can find the checked-in
    // bin/node-<triple> sidecar when running under `tauri dev` (the bundler
    // strips the suffix in packaged builds).
    let target = std::env::var("TARGET").expect("cargo sets TARGET for build scripts");
    println!("cargo:rustc-env=LIBREDB_TARGET_TRIPLE={target}");
    tauri_build::build();
}
