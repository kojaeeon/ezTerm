//! Convert the actual Windows shell icon to a transparent PNG. All native
//! resources are owned by guards and released on both success and failure.
#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    const SIDE: usize = 16;

    #[repr(C)]
    struct ShellFileInfo {
        icon: Handle,
        index: i32,
        attributes: u32,
        display_name: [u16; 260],
        type_name: [u16; 80],
    }
    #[repr(C)]
    struct BitmapHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bits: u16,
        compression: u32,
        image_size: u32,
        x_resolution: i32,
        y_resolution: i32,
        colors_used: u32,
        important_colors: u32,
    }
    #[repr(C)]
    struct BitmapInfo {
        header: BitmapHeader,
        color: u32,
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetFileInfoW(
            path: *const u16,
            attributes: u32,
            info: *mut ShellFileInfo,
            info_size: u32,
            flags: u32,
        ) -> usize;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn DestroyIcon(icon: Handle) -> i32;
        fn DrawIconEx(
            dc: Handle,
            x: i32,
            y: i32,
            icon: Handle,
            width: i32,
            height: i32,
            step: u32,
            brush: Handle,
            flags: u32,
        ) -> i32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: Handle, flags: u32) -> i32;
        fn CoUninitialize();
    }
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateCompatibleDC(dc: Handle) -> Handle;
        fn DeleteDC(dc: Handle) -> i32;
        fn CreateDIBSection(
            dc: Handle,
            info: *const BitmapInfo,
            usage: u32,
            bits: *mut Handle,
            section: Handle,
            offset: u32,
        ) -> Handle;
        fn SelectObject(dc: Handle, object: Handle) -> Handle;
        fn DeleteObject(object: Handle) -> i32;
        fn GdiFlush() -> i32;
    }

    struct Icon(Handle);
    impl Drop for Icon {
        fn drop(&mut self) {
            unsafe {
                DestroyIcon(self.0);
            }
        }
    }
    struct Surface {
        dc: Handle,
        bitmap: Handle,
        previous: Handle,
        pixels: *mut u8,
    }
    impl Drop for Surface {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.dc, self.previous);
                DeleteObject(self.bitmap);
                DeleteDC(self.dc);
            }
        }
    }
    impl Surface {
        fn draw(icon: Handle, background: u8) -> Option<Self> {
            let info = BitmapInfo {
                header: BitmapHeader {
                    size: 40,
                    width: SIDE as i32,
                    height: -(SIDE as i32),
                    planes: 1,
                    bits: 32,
                    compression: 0,
                    image_size: 0,
                    x_resolution: 0,
                    y_resolution: 0,
                    colors_used: 0,
                    important_colors: 0,
                },
                color: 0,
            };
            unsafe {
                let dc = CreateCompatibleDC(std::ptr::null_mut());
                if dc.is_null() {
                    return None;
                }
                let mut pixels = std::ptr::null_mut();
                let bitmap = CreateDIBSection(dc, &info, 0, &mut pixels, std::ptr::null_mut(), 0);
                if bitmap.is_null() || pixels.is_null() {
                    if !bitmap.is_null() {
                        DeleteObject(bitmap);
                    }
                    DeleteDC(dc);
                    return None;
                }
                let previous = SelectObject(dc, bitmap);
                if previous.is_null() || previous as isize == -1 {
                    DeleteObject(bitmap);
                    DeleteDC(dc);
                    return None;
                }
                let surface = Self {
                    dc,
                    bitmap,
                    previous,
                    pixels: pixels.cast(),
                };
                for pixel in std::slice::from_raw_parts_mut(surface.pixels, SIDE * SIDE * 4)
                    .chunks_exact_mut(4)
                {
                    pixel.copy_from_slice(&[background, background, background, 255]);
                }
                if DrawIconEx(
                    dc,
                    0,
                    0,
                    icon,
                    SIDE as i32,
                    SIDE as i32,
                    0,
                    std::ptr::null_mut(),
                    3,
                ) == 0
                {
                    return None;
                }
                Some(surface)
            }
        }
    }

    pub fn icon_png(path: &str) -> Option<Vec<u8>> {
        if path.contains('\0') {
            return None;
        }
        let _com = ComGuard(unsafe { CoInitializeEx(std::ptr::null_mut(), 2) } >= 0);
        let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let mut info: ShellFileInfo = unsafe { std::mem::zeroed() };
        let result = unsafe {
            SHGetFileInfoW(
                wide.as_ptr(),
                0,
                &mut info,
                std::mem::size_of::<ShellFileInfo>() as u32,
                0x100 | 0x1,
            )
        };
        if result == 0 || info.icon.is_null() {
            return None;
        }
        let icon = Icon(info.icon);
        let black_surface = Surface::draw(icon.0, 0)?;
        let white_surface = Surface::draw(icon.0, 255)?;
        unsafe {
            GdiFlush();
        }
        let black = unsafe { std::slice::from_raw_parts(black_surface.pixels, SIDE * SIDE * 4) };
        let white = unsafe { std::slice::from_raw_parts(white_surface.pixels, SIDE * SIDE * 4) };
        // Drawing against two backgrounds recovers transparency for both
        // modern alpha icons and older Windows icons with a separate mask.
        let mut rgba = Vec::with_capacity(SIDE * SIDE * 4);
        for (b, w) in black.chunks_exact(4).zip(white.chunks_exact(4)) {
            let alpha = 255
                - (0..3)
                    .map(|i| w[i].saturating_sub(b[i]))
                    .max()
                    .unwrap_or(255);
            for channel in [2, 1, 0] {
                rgba.push(if alpha == 0 {
                    0
                } else {
                    ((b[channel] as u32 * 255 + alpha as u32 / 2) / alpha as u32).min(255) as u8
                });
            }
            rgba.push(alpha);
        }
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, SIDE as u32, SIDE as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
        }
        Some(bytes)
    }
}

#[cfg(windows)]
pub use windows::icon_png;
#[cfg(not(windows))]
pub fn icon_png(_path: &str) -> Option<Vec<u8>> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn windows_icons_are_valid_transparent_pngs() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("한글.txt");
        std::fs::write(&file, b"text").unwrap();
        for path in [
            folder.path(),
            file.as_path(),
            std::path::Path::new(r"C:\Windows\System32\notepad.exe"),
        ] {
            let bytes = super::icon_png(path.to_str().unwrap()).expect("Windows shell icon");
            let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
            let mut reader = decoder.read_info().unwrap();
            assert_eq!((reader.info().width, reader.info().height), (16, 16));
            let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut pixels).unwrap();
            assert_eq!(info.color_type, png::ColorType::Rgba);
            assert!(pixels.chunks_exact(4).any(|p| p[3] > 0));
            assert!(pixels.chunks_exact(4).any(|p| p[3] < 255));
        }
    }
}
