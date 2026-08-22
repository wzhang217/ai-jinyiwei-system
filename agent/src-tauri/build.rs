use std::fs::{create_dir_all, File};
use std::path::PathBuf;

fn main() {
    let icon_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("icons");
    create_dir_all(&icon_dir).expect("create icon directory");
    let icon_path = icon_dir.join("icon.png");
    if !icon_path.exists() {
        let file = File::create(icon_path).expect("create generated icon");
        let mut encoder = png::Encoder::new(file, 32, 32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("write icon header");
        let mut pixels = Vec::with_capacity(32 * 32 * 4);
        for y in 0..32 {
            for x in 0..32 {
                let inset = (4..28).contains(&x) && (4..28).contains(&y);
                let center = (10..22).contains(&x) && (7..25).contains(&y);
                let color = if center {
                    [255, 255, 255, 255]
                } else if inset {
                    [36, 70, 59, 255]
                } else {
                    [226, 239, 231, 255]
                };
                pixels.extend_from_slice(&color);
            }
        }
        writer.write_image_data(&pixels).expect("write icon pixels");
    }
    tauri_build::build()
}
