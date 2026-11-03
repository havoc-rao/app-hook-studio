import { CodeBuddySettings, validateSettings } from "./settings";
import { parseShortcut } from "../../core/shortcuts";
// Immutable v1 renderer retained solely to identify and migrate existing installed patches.
export const V1_BEGIN = "/* APP_HOOK_STUDIO_BEGIN v1 codebuddy-cn ";
export const V1_END = "/* APP_HOOK_STUDIO_END */\n";

export function renderHookV1(value: CodeBuddySettings): string {
  const config = validateSettings(value);
  const runtime = {
    newChat: config.newChatEnabled ? parseShortcut(config.newChatShortcut) : null,
    stop: config.stopMode === "shortcut" ? parseShortcut(config.stopShortcut) : null,
    stopMode: config.stopMode,
    doubleEscapeMs: config.doubleEscapeMs,
    scope: config.scope,
  };
  const metadata = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  return `${V1_BEGIN}${metadata} */
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
${V1_END}`;
}
