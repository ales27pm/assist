import React from 'react';
import { StyleSheet, View } from 'react-native';
import { uiGrammar } from './uiGrammar';

type IconName =
  | 'chat'
  | 'model'
  | 'lab'
  | 'send'
  | 'add'
  | 'settings'
  | 'arrow'
  | 'spark'
  | 'compose'
  | 'appearance'
  | 'import'
  | 'voice'
  | 'stop';

type InterfaceIconProps = {
  name: IconName;
  size?: number;
  color?: string;
};

type Line = readonly [number, number, number, number];
type Outline = readonly [number, number, number, number, number];

const paths: Record<IconName, readonly Line[]> = {
  chat: [
    [5.5, 16.5, 5.5, 20],
    [5.5, 20, 10, 16.5],
  ],
  model: [
    [12, 3, 21, 8],
    [21, 8, 21, 17],
    [21, 17, 12, 22],
    [12, 22, 3, 17],
    [3, 17, 3, 8],
    [3, 8, 12, 3],
    [3, 8, 12, 13],
    [12, 13, 21, 8],
    [12, 13, 12, 22],
  ],
  lab: [
    [5, 18, 5, 12],
    [12, 18, 12, 5],
    [19, 18, 19, 9],
    [4, 21, 20, 21],
  ],
  send: [
    [21, 3, 14, 21],
    [14, 21, 10, 14],
    [10, 14, 3, 10],
    [3, 10, 21, 3],
    [10, 14, 21, 3],
  ],
  add: [
    [5, 12, 19, 12],
    [12, 5, 12, 19],
  ],
  settings: [
    [7, 4, 7, 7],
    [7, 12, 7, 20],
    [17, 4, 17, 12],
    [17, 17, 17, 20],
  ],
  arrow: [
    [5, 12, 19, 12],
    [13.5, 6.5, 19, 12],
    [19, 12, 13.5, 17.5],
  ],
  spark: [
    [12, 3, 14.5, 9.5],
    [14.5, 9.5, 21, 12],
    [21, 12, 14.5, 14.5],
    [14.5, 14.5, 12, 21],
    [12, 21, 9.5, 14.5],
    [9.5, 14.5, 3, 12],
    [3, 12, 9.5, 9.5],
    [9.5, 9.5, 12, 3],
  ],
  compose: [
    [12, 5, 5, 5],
    [5, 5, 5, 19],
    [5, 19, 19, 19],
    [19, 19, 19, 12],
    [11, 13, 20, 4],
    [17.5, 4, 20, 6.5],
    [11, 13, 10, 16],
    [10, 16, 13, 15],
  ],
  appearance: [],
  import: [
    [12, 16, 12, 3],
    [6.5, 8.5, 12, 3],
    [12, 3, 17.5, 8.5],
    [4, 13, 4, 21],
    [4, 21, 20, 21],
    [20, 21, 20, 13],
  ],
  stop: [],
  voice: [
    [4, 9, 8, 9],
    [8, 9, 12, 5],
    [12, 5, 12, 19],
    [12, 19, 8, 15],
    [8, 15, 4, 15],
    [4, 15, 4, 9],
    [16, 9, 17, 12],
    [17, 12, 16, 15],
    [19, 6, 21, 12],
    [21, 12, 19, 18],
  ],
};

const outlines: Partial<Record<IconName, readonly Outline[]>> = {
  chat: [[4, 4, 16, 13, 4]],
  settings: [
    [4.5, 7, 5, 5, 2.5],
    [14.5, 12, 5, 5, 2.5],
  ],
};

/** Decorative icons; the enclosing control provides its accessible name. */
export function InterfaceIcon({
  name,
  size = uiGrammar.icon.size,
  color = '#243B32',
}: InterfaceIconProps) {
  const scale = size / 24;
  const stroke = uiGrammar.icon.stroke * scale;

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size }}
    >
      {outlines[name]?.map(([left, top, width, height, radius], index) => (
        <View
          key={`outline-${index}`}
          style={[
            styles.part,
            {
              left: left * scale,
              top: top * scale,
              width: width * scale,
              height: height * scale,
              borderWidth: stroke,
              borderColor: color,
              borderRadius: radius * scale,
            },
          ]}
        />
      ))}
      {paths[name].map(([x1, y1, x2, y2], index) => {
        const length = Math.hypot(x2 - x1, y2 - y1) * scale;
        const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;

        return (
          <View
            key={`line-${index}`}
            style={[
              styles.part,
              {
                left: ((x1 + x2) / 2) * scale - length / 2,
                top: ((y1 + y2) / 2) * scale - stroke / 2,
                width: length + stroke / 2,
                height: stroke,
                borderRadius: stroke / 2,
                backgroundColor: color,
                transform: [{ rotate: `${angle}deg` }],
              },
            ]}
          />
        );
      })}
      {name === 'stop' && (
        <View
          style={[
            styles.part,
            {
              left: 7 * scale,
              top: 7 * scale,
              width: 10 * scale,
              height: 10 * scale,
              borderRadius: 1.5 * scale,
              backgroundColor: color,
            },
          ]}
        />
      )}
      {name === 'appearance' && (
        <View
          style={[
            styles.part,
            styles.clipped,
            {
              left: 4 * scale,
              top: 4 * scale,
              width: 16 * scale,
              height: 16 * scale,
              borderWidth: stroke,
              borderColor: color,
              borderRadius: 8 * scale,
            },
          ]}
        >
          <View
            style={[
              styles.part,
              {
                left: -stroke,
                top: -stroke,
                width: 8 * scale,
                height: 16 * scale,
                backgroundColor: color,
              },
            ]}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  part: { position: 'absolute' },
  clipped: { overflow: 'hidden' },
});
