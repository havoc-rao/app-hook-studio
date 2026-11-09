import { V1_BEGIN, renderHookV1 } from "./hook-v1";
import { renderFocusReceiver } from "./focus-receiver";
import { DEFAULT_SETTINGS, CodeBuddySettings, validateSettings } from "./settings";
import { parseShortcut } from "../../core/shortcuts";
import { sha256 } from "../../core/hash";
import { PROFILE, UPDATED_PROFILE, WEBVIEW_PROFILES, WebviewProfile } from "./profile";
import { tokenizer } from "acorn";

export const BEGIN = "/* APP_HOOK_STUDIO_BEGIN v2 codebuddy-cn ";
export const END = "/* APP_HOOK_STUDIO_END */\n";

/** Rename identifier tokens only; strings, comments and encoded metadata stay byte-exact. */
function bindUpdatedHook(source: string): string {
  const names: Record<string, string> = { Ce: "ye", le: "se", Ne: "Le", Re: "Ae", Ae: "je", Ue: "Ve" };
  const tokens = tokenizer(source, { ecmaVersion: "latest" });
  let result = "",
    previous = 0;
  for (const token of tokens) {
    const name = source.slice(token.start, token.end);
    if (token.type.label === "name" && names[name]) {
      result += source.slice(previous, token.start) + names[name];
      previous = token.end;
    }
  }
  return result + source.slice(previous);
}

export function renderHook(value: CodeBuddySettings, profile: WebviewProfile = PROFILE): string {
  const source = renderOriginalHook(value);
  return profile.id === UPDATED_PROFILE.id ? bindUpdatedHook(source) : source;
}

function renderOriginalHook(value: CodeBuddySettings): string {
  const config = validateSettings(value);
  const runtime = {
    newChat: config.newChatEnabled ? parseShortcut(config.newChatShortcut) : null,
    stop: config.stopMode === "shortcut" ? parseShortcut(config.stopShortcut) : null,
    stopMode: config.stopMode,
    doubleEscapeMs: config.doubleEscapeMs,
    scope: config.scope,
  };
  const metadata = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  return `${BEGIN}${metadata} */
const cbHotkeysState=(0,m.useRef)({lastEscape:null,cancel:Ce,streaming:le,busy:false});
cbHotkeysState.current.cancel=Ce;
cbHotkeysState.current.streaming=le;
if(!le)cbHotkeysState.current.lastEscape=null;
(0,m.useEffect)(()=>{
  if(Ne)return;
  const input=Re.current;
  const panel=input&&Ae(input);
  const config=${JSON.stringify(runtime)};
  const root=config.scope==="input"?input:panel;
  if(!input||!root)return;
  const state=cbHotkeysState.current;
  const reset=()=>{state.lastEscape=null;};
  const matches=(event,key)=>key&&event.code===key.code&&event.ctrlKey===key.ctrl&&
    event.metaKey===key.meta&&event.altKey===key.alt&&event.shiftKey===key.shift;
  const handle=event=>{
    if(event.defaultPrevented||event.isComposing||!input.getClientRects().length){reset();return;}
    if(!(event.target instanceof Node)||!root.contains(event.target)){reset();return;}
    if(event.repeat)return;
    const newChat=matches(event,config.newChat);
    let stop=false;
    if(config.stopMode==="double-escape"&&event.key==="Escape"&&
       !event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&
       state.streaming&&typeof state.cancel==="function"){
      const now=performance.now(),previous=state.lastEscape;
      stop=previous!==null&&now-previous>=0&&now-previous<=config.doubleEscapeMs;
      state.lastEscape=stop?null:now;
    }else{
      reset();
      stop=config.stopMode==="shortcut"&&matches(event,config.stop)&&
        state.streaming&&typeof state.cancel==="function";
    }
    if(!newChat&&!stop)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(state.busy)return;
    state.busy=true;
    Promise.resolve().then(()=>newChat
      ?r("wGu3").ContainerUtil.get(r("vFXG").NewChatViewServie).startNewChat()
      :state.cancel()).catch(error=>console.error("[App Hook Studio: codebuddy-cn]",error))
      .finally(()=>{state.busy=false;});
  };
  root.addEventListener("keydown",handle);
  root.addEventListener("focusout",reset);
  window.addEventListener("blur",reset);
  return()=>{
    root.removeEventListener("keydown",handle);
    root.removeEventListener("focusout",reset);
    window.removeEventListener("blur",reset);
    reset();
  };
},[Ne,Ae]);
${renderFocusReceiver()}${END}`;
}

export type BundleAnalysis = {
  kind: "original" | "legacy" | "managed";
  original: string;
  installedSettings?: CodeBuddySettings;
  upgradeRequired?: boolean;
};

/** Accept exact supported bytes, or a reproducible patch over those exact bytes. */
export function analyzeBundle(source: string): BundleAnalysis {
  const digest = sha256(source);
  if (WEBVIEW_PROFILES.some((profile) => digest === profile.originalSha256))
    return { kind: "original", original: source };
  if (digest === PROFILE.legacySha256) {
    const start = source.indexOf(PROFILE.legacyStart);
    const end = source.indexOf(PROFILE.legacyEnd, start) + PROFILE.legacyEnd.length;
    if (start < 0 || end < start) throw new Error("旧补丁边界异常，拒绝修改。");
    const original = source.slice(0, start) + source.slice(end);
    if (sha256(original) !== PROFILE.originalSha256) throw new Error("旧补丁原文校验失败。");
    return { kind: "legacy", original, installedSettings: { ...DEFAULT_SETTINGS } };
  }
  const v1 = source.includes(V1_BEGIN);
  const marker = v1 ? V1_BEGIN : BEGIN;
  const start = source.indexOf(marker);
  const endAt = source.indexOf(END, start);
  if (start < 0 || endAt < start || source.indexOf(marker, start + marker.length) >= 0) {
    throw new Error("应用源码摘要不匹配：当前版本或其他改动不受支持，未修改任何文件。");
  }
  const end = endAt + END.length;
  const block = source.slice(start, end);
  const header = /^\/\* APP_HOOK_STUDIO_BEGIN v[12] codebuddy-cn ([A-Za-z0-9+/=]+) \*\/\n/.exec(block);
  if (!header) throw new Error("补丁元数据格式异常，拒绝修改。");
  const config = validateSettings(JSON.parse(Buffer.from(header[1], "base64").toString("utf8")));
  const original = source.slice(0, start) + source.slice(end);
  const profile = WEBVIEW_PROFILES.find((candidate) => candidate.originalSha256 === sha256(original));
  if (
    !profile ||
    (v1 && profile.id !== PROFILE.id) ||
    (v1 ? renderHookV1(config) : renderHook(config, profile)) !== block
  )
    throw new Error("补丁内容与配置不一致或原始源码摘要不匹配，拒绝覆盖未知改动。");
  if (original.indexOf(profile.anchor) !== start) {
    throw new Error("补丁位置或原始源码摘要不匹配，拒绝修改。");
  }
  return { kind: "managed", original, installedSettings: config, upgradeRequired: v1 };
}

export function patchBundle(original: string, config: CodeBuddySettings): string {
  const profile = WEBVIEW_PROFILES.find((candidate) => candidate.originalSha256 === sha256(original));
  if (!profile || original.split(profile.anchor).length !== 2) {
    throw new Error("原始源码或注入位置不匹配。");
  }
  return original.replace(profile.anchor, renderHook(config, profile) + profile.anchor);
}
