import React, { createContext, useContext, useMemo, useState } from 'react';

export type AppearanceId = 'light' | 'graphite' | 'blue';

export type AssistTheme = {
  id: AppearanceId;
  label: string;
  isDark: boolean;
  colors: {
    background: string;
    surface: string;
    surfaceRaised: string;
    text: string;
    muted: string;
    border: string;
    separator: string;
    accent: string;
    onAccent: string;
    userBubble: string;
    userText: string;
    assistantBubble: string;
    composer: string;
    placeholder: string;
    danger: string;
    dangerSurface: string;
    chip: string;
    activeSurface: string;
  };
};

export const themes: Record<AppearanceId, AssistTheme> = {
  light: {
    id: 'light',
    label: 'Natif clair',
    isDark: false,
    colors: {
      background: '#F8F9FC',
      surface: '#FFFFFF',
      surfaceRaised: '#F0F3F9',
      text: '#18202E',
      muted: '#536078',
      border: '#7C869A',
      separator: '#DCE2EC',
      accent: '#2455DC',
      onAccent: '#FFFFFF',
      userBubble: '#E8EEFF',
      userText: '#18202E',
      assistantBubble: '#EDF1F8',
      composer: '#FFFFFF',
      placeholder: '#627089',
      danger: '#AB263B',
      dangerSurface: '#FFF0F2',
      chip: '#EDF1F9',
      activeSurface: '#E9EFFF',
    },
  },
  graphite: {
    id: 'graphite',
    label: 'Graphite',
    isDark: true,
    colors: {
      background: '#101113',
      surface: '#191B1F',
      surfaceRaised: '#25282E',
      text: '#F5F5F2',
      muted: '#B6BAC2',
      border: '#767E8A',
      separator: '#30353D',
      accent: '#FFB52B',
      onAccent: '#1B160C',
      userBubble: '#333841',
      userText: '#F5F5F2',
      assistantBubble: '#202328',
      composer: '#1D2025',
      placeholder: '#AFB6C0',
      danger: '#FF9EA7',
      dangerSurface: '#3C2028',
      chip: '#2D3036',
      activeSurface: '#3A2F1B',
    },
  },
  blue: {
    id: 'blue',
    label: 'Bleu profond',
    isDark: true,
    colors: {
      background: '#09172E',
      surface: '#0E2140',
      surfaceRaised: '#172D50',
      text: '#F3F7FF',
      muted: '#AFBFD8',
      border: '#7E96B8',
      separator: '#243F64',
      accent: '#83ADFF',
      onAccent: '#09172E',
      userBubble: '#2861D7',
      userText: '#FFFFFF',
      assistantBubble: '#102A4D',
      composer: '#0E2444',
      placeholder: '#B6C6DF',
      danger: '#FF9AA7',
      dangerSurface: '#3D2035',
      chip: '#183258',
      activeSurface: '#153869',
    },
  },
};

type AppearanceContextValue = {
  theme: AssistTheme;
  appearance: AppearanceId;
  setAppearance: (appearance: AppearanceId) => void;
};

// Standalone panels retain a readable light palette without owning app state.
const AppearanceContext = createContext<AppearanceContextValue>({
  theme: themes.light,
  appearance: 'light',
  setAppearance: () => undefined,
});

/** Appearance lasts for this mounted app session; it never touches model state. */
export function AppearanceProvider({ children }: React.PropsWithChildren) {
  const [appearance, setAppearance] = useState<AppearanceId>('light');
  const value = useMemo(
    () => ({ theme: themes[appearance], appearance, setAppearance }),
    [appearance],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance() {
  return useContext(AppearanceContext);
}
