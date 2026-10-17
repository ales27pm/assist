import React, { useCallback, useId, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  KeyDownEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppearanceId, themes, useAppearance } from './appearance';
import { uiGrammar } from './uiGrammar';

type AppearancePickerProps = {
  open: boolean;
  onClose: () => void;
  onDismiss?: () => void;
};

const appearanceOptions: AppearanceId[] = ['light', 'graphite', 'blue'];

export function AppearancePicker({
  open,
  onClose,
  onDismiss,
}: AppearancePickerProps) {
  const { theme, appearance, setAppearance } = useAppearance();
  const { colors } = theme;
  const headingId = useId();
  const headingRef = useRef<React.ComponentRef<typeof Text>>(null);
  const optionRefs = useRef<
    Partial<Record<AppearanceId, React.ComponentRef<typeof Pressable>>>
  >({});
  const [focusedAppearance, setFocusedAppearance] =
    useState<AppearanceId | null>(null);
  const focusHeading = useCallback(() => {
    if (Platform.OS !== 'web') {
      const heading = findNodeHandle(headingRef.current);
      if (heading != null) {
        AccessibilityInfo.setAccessibilityFocus(heading);
      }
    }
  }, []);
  const handleOptionKeyDown = (event: KeyDownEvent, id: AppearanceId) => {
    const { key, altKey, ctrlKey, metaKey, isComposing } = event.nativeEvent;
    if (altKey || ctrlKey || metaKey || isComposing) {
      return;
    }

    const index = appearanceOptions.indexOf(id);
    let nextIndex: number;
    switch (key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex =
          (index - 1 + appearanceOptions.length) % appearanceOptions.length;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % appearanceOptions.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = appearanceOptions.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextAppearance = appearanceOptions[nextIndex];
    setAppearance(nextAppearance);
    optionRefs.current[nextAppearance]?.focus();
  };

  return (
    <Modal
      aria-labelledby={Platform.OS === 'web' ? headingId : undefined}
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={onDismiss}
      onShow={focusHeading}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <SafeAreaView
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          edges={['bottom', 'left', 'right']}
          style={[
            styles.sheet,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <View
            accessible={false}
            style={[styles.handle, { backgroundColor: colors.border }]}
          />
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.header}>
              <Text
                ref={headingRef}
                nativeID={headingId}
                accessibilityRole="header"
                style={[styles.title, { color: colors.text }]}
              >
                Apparence
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Fermer l’apparence"
                onPress={onClose}
                style={({ pressed }) => [
                  styles.close,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.closeLabel, { color: colors.text }]}>
                  Fermer
                </Text>
              </Pressable>
            </View>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel="Thème de l’interface"
              style={styles.options}
            >
              {appearanceOptions.map(id => {
                const option = themes[id];
                const selected = id === appearance;
                const focused = id === focusedAppearance;

                return (
                  <Pressable
                    key={id}
                    ref={node => {
                      optionRefs.current[id] = node ?? undefined;
                    }}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ checked: selected }}
                    aria-checked={selected}
                    tabIndex={
                      Platform.OS === 'web' ? (selected ? 0 : -1) : undefined
                    }
                    onPress={() => setAppearance(id)}
                    onKeyDown={
                      Platform.OS === 'web'
                        ? event => handleOptionKeyDown(event, id)
                        : undefined
                    }
                    onFocus={() => setFocusedAppearance(id)}
                    onBlur={() => setFocusedAppearance(null)}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        backgroundColor: selected
                          ? colors.activeSurface
                          : colors.surfaceRaised,
                        borderColor:
                          selected || focused ? colors.accent : colors.border,
                      },
                      focused && styles.focusedOption,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View
                      accessible={false}
                      importantForAccessibility="no-hide-descendants"
                      style={[
                        styles.radio,
                        {
                          borderColor: selected ? colors.accent : colors.border,
                        },
                      ]}
                    >
                      {selected && (
                        <View
                          style={[
                            styles.radioDot,
                            { backgroundColor: colors.accent },
                          ]}
                        />
                      )}
                    </View>
                    <Text style={[styles.optionLabel, { color: colors.text }]}>
                      {option.label}
                    </Text>
                    <View
                      accessible={false}
                      importantForAccessibility="no-hide-descendants"
                      style={styles.swatches}
                    >
                      {[
                        option.colors.background,
                        option.colors.surfaceRaised,
                        option.colors.accent,
                      ].map((color, index) => (
                        <View
                          key={index}
                          style={[
                            styles.swatch,
                            {
                              backgroundColor: color,
                              borderColor: colors.border,
                            },
                          ]}
                        />
                      ))}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.note, { color: colors.muted }]}>
              S’applique à toute l’app. Conservé pendant cette session.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
  },
  sheet: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 560,
    maxHeight: '90%',
    borderWidth: 1,
    borderTopLeftRadius: uiGrammar.radius.bubble,
    borderTopRightRadius: uiGrammar.radius.bubble,
    paddingTop: uiGrammar.unit * 3,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: uiGrammar.unit,
    borderRadius: 2,
  },
  content: {
    paddingHorizontal: uiGrammar.gutter,
    paddingTop: uiGrammar.unit * 3,
    paddingBottom: uiGrammar.gutter,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: uiGrammar.unit * 3,
    marginBottom: uiGrammar.unit * 4,
  },
  title: {
    flexShrink: 1,
    ...uiGrammar.type.navigation,
    fontWeight: '600',
  },
  close: {
    minWidth: 64,
    minHeight: uiGrammar.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: uiGrammar.unit,
  },
  closeLabel: { ...uiGrammar.type.label, fontWeight: '600' },
  options: { gap: uiGrammar.unit * 3 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: uiGrammar.unit * 3,
    minHeight: 84,
    borderWidth: 2,
    borderRadius: uiGrammar.radius.bubble,
    paddingHorizontal: uiGrammar.unit * 4,
    paddingVertical: uiGrammar.unit * 4,
  },
  focusedOption: { borderStyle: 'dashed' },
  radio: {
    width: uiGrammar.icon.size,
    height: uiGrammar.icon.size,
    borderWidth: 2,
    borderRadius: uiGrammar.icon.size / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: {
    width: uiGrammar.unit * 3,
    height: uiGrammar.unit * 3,
    borderRadius: (uiGrammar.unit * 3) / 2,
  },
  optionLabel: { flex: 1, ...uiGrammar.type.body, fontWeight: '600' },
  swatches: { flexDirection: 'row', gap: uiGrammar.unit },
  swatch: {
    width: uiGrammar.unit * 4,
    height: uiGrammar.unit * 6,
    borderRadius: uiGrammar.unit,
    borderWidth: 1,
  },
  note: { marginTop: uiGrammar.gutter, ...uiGrammar.type.caption },
  pressed: { opacity: 0.72 },
});
