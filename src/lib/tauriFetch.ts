/**
 * Drop-in fetch replacement that routes through Rust's reqwest via tauri-plugin-http.
 * This bypasses WebKit's CORS sandbox — required for calls to api.proton.me.
 */
export { fetch } from "@tauri-apps/plugin-http";
