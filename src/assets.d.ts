declare module "*.c" { const text: string; export default text; }
declare module "*.h" { const text: string; export default text; }
declare module "*.s" { const text: string; export default text; }
declare module "*.cfg" { const text: string; export default text; }
/** Uncompressed byte sizes of dist/wasm/*, injected at build time for download progress. */
declare const __ASSET_SIZES__: Record<string, number>;
