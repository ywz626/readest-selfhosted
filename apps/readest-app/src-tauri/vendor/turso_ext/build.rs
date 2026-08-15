fn main() {
    // NOTE: patched locally for Readest self-hosted Android build.
    // The upstream crate used `cfg!(target_os = "windows")` which evaluates
    // against the build-script HOST (Windows), wrongly adding `-ladvapi32`
    // when cross-compiling to Android. Check the real target instead.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
