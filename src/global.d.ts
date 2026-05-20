// Type augmentations for Uint8Array native base64/hex helpers.
// These methods are available in modern WebKit/Blink used by Tauri v2.
// Required by @protontech/crypto which distributes TypeScript source directly.
// Must use generic form to match TypeScript 5.x's Uint8Array<TBuffer>.

type OptionsFromBase64 = {
  alphabet?: "base64" | "base64url";
  lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
};

declare global {
  interface Uint8ArrayConstructor {
    fromBase64: (base64: string, options?: OptionsFromBase64) => Uint8Array<ArrayBuffer>;
    fromHex: (hex: string) => Uint8Array<ArrayBuffer>;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
    toBase64: (options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }) => string;
    toHex: () => string;
    setFromBase64(base64: string, options?: OptionsFromBase64): { read: number; written: number };
  }
}
