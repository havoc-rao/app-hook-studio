// Design example, not loaded by the current extension.
// The compiler would embed this factory into the verified target component scope.
export function bind({ appRequire }) {
  return {
    newChat() {
      return appRequire("wGu3").ContainerUtil.get(appRequire("vFXG").NewChatViewServie).startNewChat();
    },
  };
}
