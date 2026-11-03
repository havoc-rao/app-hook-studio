import { FOCUS_REQUEST, FOCUS_ACK } from "./focus-protocol";
export function renderFocusReceiver(): string {
  return `(0,m.useEffect)(()=>{
  if(Ne)return;
  const timers=new Set();
  const handle=event=>{
    const message=event.data;
    if(!message||message.type!==${JSON.stringify(FOCUS_REQUEST)}||typeof message.requestId!=="string")return;
    const input=Re.current,editor=Ue.current;
    if(!input||!input.getClientRects().length||!editor||typeof editor.focus!=="function")return;
    editor.focus();
    const timer=setTimeout(()=>{
      timers.delete(timer);
      const active=document.activeElement;
      const focused=!!(active&&input.contains(active)&&(active.isContentEditable||active.tagName==="TEXTAREA"||active.tagName==="INPUT"));
      const bridge=window.vs||window.vscode;
      if(bridge&&typeof bridge.postMessage==="function")bridge.postMessage({type:${JSON.stringify(FOCUS_ACK)},requestId:message.requestId,focused});
    },0);
    timers.add(timer);
  };
  window.addEventListener("message",handle);
  return()=>{window.removeEventListener("message",handle);for(const timer of timers)clearTimeout(timer);timers.clear();};
},[Ne]);
`;
}
