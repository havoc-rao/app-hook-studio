export const PROFILE = {
  id: "codebuddy-cn-genie-3.10.0-ee829469",
  appVersion: "1.106.1",
  extensionVersion: "3.10.0",
  bundleRelativePath: "Contents/Resources/app/extensions/genie/out/webviews/main.942dbf9a.chunk.js",
  originalSha256: "ee829469ee2b4edd4c04f09f8b828840f196c82e22f5973d909ce6f29445c31f",
  // User-verified Esc/Esc prototype from this investigation; reconstructs the exact original.
  legacySha256: "1d6964015558e2d565f37e4421c863fe8729cf4c4492112f79b283ce1fa76cfe",
  legacyStart: "/* REA local hotkeys prototype: CodeBuddy genie 3.10.0 */\n",
  legacyEnd: "},[Ne,le,Ce,Ae]);\n",
  anchor: "const{setNavigationAllowed:Tn,navigateToInputContextLast:In}=",
} as const;

// Same advertised versions, different shipped bytes and ChatInput lexical bindings.
export const UPDATED_PROFILE = {
  ...PROFILE,
  id: "codebuddy-cn-genie-3.10.0-1100a2cb",
  bundleRelativePath: "Contents/Resources/app/extensions/genie/out/webviews/main.4e7322ea.chunk.js",
  originalSha256: "1100a2cbddd023c284b90b2b450e725301575ba6bdb3c6498649127c7888f702",
  anchor: "const{setNavigationAllowed:On,navigateToInputContextLast:xn}=",
} as const;
export const WEBVIEW_PROFILES = [UPDATED_PROFILE, PROFILE] as const;
export type WebviewProfile = (typeof WEBVIEW_PROFILES)[number];
