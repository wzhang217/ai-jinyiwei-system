use std::fs::{create_dir_all, write};
use std::io::Cursor;
use std::path::PathBuf;

fn icon_pixels() -> Vec<u8> {
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
    pixels
}

fn png_bytes() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(Cursor::new(&mut bytes), 32, 32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("write icon header");
        writer
            .write_image_data(&icon_pixels())
            .expect("write icon pixels");
    }
    bytes
}

fn ico_bytes() -> Vec<u8> {
    let image = ico::IconImage::from_rgba_data(32, 32, icon_pixels());
    let mut icon_dir = ico::IconDir::new(ico::ResourceType::Icon);
    icon_dir.add_entry(ico::IconDirEntry::encode_as_bmp(&image).expect("encode BMP icon entry"));

    let mut bytes = Vec::new();
    icon_dir
        .write(Cursor::new(&mut bytes))
        .expect("write generated ICO icon");
    bytes
}

fn main() {
    let icon_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("icons");
    create_dir_all(&icon_dir).expect("create icon directory");
    let png = png_bytes();
    let icon_path = icon_dir.join("icon.png");
    write(&icon_path, &png).expect("write generated PNG icon");

    let ico_path = icon_dir.join("icon.ico");
    write(&ico_path, ico_bytes()).expect("write generated ICO icon");

    tauri_build::build()
}
