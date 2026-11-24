use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR absent"));
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR absent"));
    println!("cargo:rerun-if-changed={}", root.join("public").display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("docs").join("MANUEL.md").display()
    );
    let files = [
        (["build", "three.module.js"].as_slice(), "three.module.js"),
        (["build", "three.core.js"].as_slice(), "three.core.js"),
        (
            ["examples", "jsm", "controls", "OrbitControls.js"].as_slice(),
            "OrbitControls.js",
        ),
        (["LICENSE"].as_slice(), "three-LICENSE"),
    ];

    for (parts, name) in files {
        let mut source = root.join("node_modules").join("three");
        for part in parts {
            source.push(part);
        }
        println!("cargo:rerun-if-changed={}", source.display());
        fs::copy(&source, out.join(name)).unwrap_or_else(|error| {
            panic!(
                "Impossible d'intégrer {} : {error}. Exécutez d'abord npm ci.",
                source.display()
            )
        });
    }
}
