import React, { useId, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppearance } from './appearance';
import { InterfaceIcon } from './InterfaceIcon';
import { uiGrammar } from './uiGrammar';

export function ScreenHeading({
  eyebrow,
  title,
  description,
  headingRef,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  headingRef?: React.Ref<React.ComponentRef<typeof Text>>;
}) {
  const { theme } = useAppearance();
  const webHeadingProps: { tabIndex?: -1 } =
    Platform.OS === 'web' ? { tabIndex: -1 } : {};
  return (
    <View style={styles.heading}>
      {eyebrow && (
        <Text style={[styles.eyebrow, { color: theme.colors.muted }]}>
          {eyebrow}
        </Text>
      )}
      <Text
        {...webHeadingProps}
        ref={headingRef}
        role="heading"
        style={[styles.title, { color: theme.colors.text }]}
      >
        {title}
      </Text>
      {description && (
        <Text style={[styles.description, { color: theme.colors.muted }]}>
          {description}
        </Text>
      )}
    </View>
  );
}

export function SurfaceGroup({
  title,
  children,
}: React.PropsWithChildren<{ title?: string }>) {
  const { theme } = useAppearance();
  return (
    <View style={styles.section}>
      {title && (
        <Text
          accessibilityRole="header"
          style={[styles.sectionLabel, { color: theme.colors.muted }]}
        >
          {title}
        </Text>
      )}
      <View
        style={[
          styles.surface,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.separator,
          },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  disabled = false,
  primary = false,
  destructive = false,
  hint,
}: {
  label: string;
  onPress: () => unknown;
  disabled?: boolean;
  primary?: boolean;
  destructive?: boolean;
  hint?: string;
}) {
  const { theme } = useAppearance();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => onPress()}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: primary
            ? theme.colors.accent
            : theme.colors.surfaceRaised,
          borderColor: primary ? theme.colors.accent : theme.colors.border,
        },
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.actionText,
          {
            color: primary
              ? theme.colors.onAccent
              : destructive
              ? theme.colors.danger
              : theme.colors.text,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SettingsRow({
  label,
  value,
  detail,
  onPress,
  last = false,
  controlRef,
  icon,
  disabled = false,
  stacked = false,
}: {
  label: string;
  value?: string;
  detail?: string;
  onPress: () => void;
  last?: boolean;
  controlRef?: React.Ref<React.ComponentRef<typeof View>>;
  icon?: 'model' | 'chat' | 'appearance' | 'lab';
  disabled?: boolean;
  stacked?: boolean;
}) {
  const { theme } = useAppearance();
  const descriptionId = useId();
  const valueId = `${descriptionId}-value`;
  const detailId = `${descriptionId}-detail`;
  const describedBy = [value && valueId, detail && detailId]
    .filter(Boolean)
    .join(' ');
  return (
    <Pressable
      ref={controlRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={value ? { text: value } : undefined}
      accessibilityHint={detail}
      aria-describedby={
        Platform.OS === 'web' ? describedBy || undefined : undefined
      }
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        stacked && styles.stackedRow,
        { borderColor: theme.colors.separator },
        !last && styles.rowBorder,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {icon && (
        <View style={styles.leadingIcon}>
          <InterfaceIcon name={icon} size={24} color={theme.colors.muted} />
        </View>
      )}
      <View style={styles.rowCopy}>
        <Text style={[styles.rowLabel, { color: theme.colors.text }]}>
          {label}
        </Text>
        {stacked && value && (
          <Text
            nativeID={valueId}
            style={[styles.stackedValue, { color: theme.colors.muted }]}
          >
            {value}
          </Text>
        )}
        {detail && (
          <Text
            nativeID={detailId}
            style={[styles.caption, { color: theme.colors.muted }]}
          >
            {detail}
          </Text>
        )}
      </View>
      {!stacked && value && (
        <Text
          nativeID={valueId}
          style={[styles.rowValue, { color: theme.colors.muted }]}
        >
          {value}
        </Text>
      )}
      <InterfaceIcon name="arrow" size={20} color={theme.colors.muted} />
    </Pressable>
  );
}

export function Disclosure({
  title,
  description,
  children,
  initiallyOpen = false,
  disabled = false,
  keepMounted = false,
  plain = false,
  icon,
}: React.PropsWithChildren<{
  title: string;
  description?: string;
  initiallyOpen?: boolean;
  disabled?: boolean;
  keepMounted?: boolean;
  plain?: boolean;
  icon?: 'import';
}>) {
  const { theme } = useAppearance();
  const [open, setOpen] = useState(initiallyOpen);
  const [visited, setVisited] = useState(initiallyOpen);
  return (
    <View
      style={[
        styles.disclosure,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.separator,
        },
        plain && styles.plainDisclosure,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open, disabled }}
        aria-expanded={open}
        disabled={disabled}
        onPress={() => {
          setVisited(true);
          setOpen(value => !value);
        }}
        style={({ pressed }) => [
          styles.disclosureHeader,
          plain && styles.plainDisclosureHeader,
          pressed && styles.pressed,
        ]}
      >
        {icon && (
          <View style={styles.leadingIcon}>
            <InterfaceIcon name={icon} size={24} color={theme.colors.muted} />
          </View>
        )}
        <View style={styles.rowCopy}>
          <Text style={[styles.rowLabel, { color: theme.colors.text }]}>
            {title}
          </Text>
          {description && (
            <Text style={[styles.caption, { color: theme.colors.muted }]}>
              {description}
            </Text>
          )}
        </View>
        <View style={{ transform: [{ rotate: open ? '-90deg' : '90deg' }] }}>
          <InterfaceIcon name="arrow" size={20} color={theme.colors.muted} />
        </View>
      </Pressable>
      {(open || (keepMounted && visited)) && (
        <View
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.disclosureBody,
            { borderColor: theme.colors.separator },
            plain && styles.plainDisclosureBody,
            !open && styles.hidden,
          ]}
        >
          {children}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { gap: 8, paddingTop: 8, paddingBottom: 8 },
  eyebrow: { ...uiGrammar.type.caption, fontWeight: '600', letterSpacing: 1 },
  title: { ...uiGrammar.type.display, fontWeight: '500', letterSpacing: -0.6 },
  description: { ...uiGrammar.type.body, marginTop: 4 },
  section: { gap: 8 },
  sectionLabel: {
    ...uiGrammar.type.caption,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  surface: {
    borderWidth: 1,
    borderRadius: uiGrammar.radius.surface,
    paddingHorizontal: 16,
  },
  action: {
    minHeight: uiGrammar.action.height,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: uiGrammar.radius.control,
    borderWidth: 1,
    justifyContent: 'center',
  },
  actionText: {
    ...uiGrammar.type.label,
    fontWeight: '600',
    textAlign: 'center',
  },
  row: {
    minHeight: uiGrammar.row.minHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
  },
  rowBorder: { borderBottomWidth: 1 },
  stackedRow: {
    minHeight: uiGrammar.row.stackedMinHeight,
    gap: uiGrammar.row.iconGap,
    paddingVertical: uiGrammar.harmony.space.large,
  },
  rowCopy: { flex: 1, gap: 4 },
  leadingIcon: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: { ...uiGrammar.type.body, fontWeight: '500' },
  stackedValue: uiGrammar.type.label,
  rowValue: {
    ...uiGrammar.type.label,
    maxWidth: '43%',
    textAlign: 'right',
    flexShrink: 1,
  },
  caption: uiGrammar.type.caption,
  disclosure: { borderWidth: 1, borderRadius: uiGrammar.radius.surface },
  disclosureHeader: {
    minHeight: uiGrammar.row.minHeight,
    padding: 16,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  disclosureBody: { borderTopWidth: 1, padding: 16, gap: 12 },
  plainDisclosure: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderBottomWidth: 1,
    borderRadius: 0,
  },
  plainDisclosureHeader: {
    minHeight: uiGrammar.row.stackedMinHeight,
    gap: uiGrammar.row.iconGap,
    paddingHorizontal: 0,
  },
  plainDisclosureBody: { paddingHorizontal: 0, paddingBottom: 21 },
  hidden: { display: 'none' },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.7 },
});
