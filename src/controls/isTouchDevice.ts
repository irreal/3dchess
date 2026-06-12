/** True on phones/tablets where we drive the game with on-screen controls. */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
