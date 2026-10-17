import { AccessibilityInfo, findNodeHandle, Platform } from 'react-native';

/** Resolve after the new screen commits; cancelled navigation must not steal focus. */
export function scheduleAccessibilityFocus(target: () => unknown) {
  const frame = requestAnimationFrame(() => {
    const node = target();
    if (!node) return;
    if (Platform.OS === 'web') {
      (node as { focus?: () => void }).focus?.();
      return;
    }
    const handle = findNodeHandle(node as Parameters<typeof findNodeHandle>[0]);
    if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
  });
  return () => cancelAnimationFrame(frame);
}
