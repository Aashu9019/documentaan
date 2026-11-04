use std::path::Path;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

/// First command-line argument that is an existing .pdf file (set when the user
/// double-clicks a PDF or chooses "Open with Documentaan").
fn pdf_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| {
            let p = Path::new(a);
            p.is_file()
                && p.extension()
                    .map(|e| e.eq_ignore_ascii_case("pdf"))
                    .unwrap_or(false)
        })
        .cloned()
}

#[tauri::command]
fn initial_file() -> Option<String> {
    pdf_arg(&std::env::args().collect::<Vec<_>>())
}

/// Read a file and return its raw bytes (arrives as an ArrayBuffer in JS).
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// Write raw bytes from the request body to the path in the `x-path` header.
#[tauri::command]
fn write_file(request: Request) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let path = urlencoding::decode(raw).map_err(|e| e.to_string())?.into_owned();
    match request.body() {
        InvokeBody::Raw(data) => std::fs::write(&path, data).map_err(|e| e.to_string()),
        _ => Err("expected raw body".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (e.g. double-clicking another PDF) reuses the open window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(p) = pdf_arg(&args) {
                let _ = app.emit("open-file", p);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![initial_file, read_file, write_file])
        .run(tauri::generate_context!())
        .expect("error while running Documentaan");
}
